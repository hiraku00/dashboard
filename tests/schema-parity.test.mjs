import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";

// db/index.ts's ensureSchema() is the working source of truth for the
// schema (its own docstring says so), and migrations/*.sql is what has
// actually been applied to the production database via wrangler's
// migrations_dir. The two have to be kept in step by hand -- there is no
// automatic check that they agree, so a column added to one and forgotten
// in the other goes unnoticed (this already happened once: see the
// KNOWN_GAPS entry below). This test parses both, column-by-column per
// table, and fails if db/index.ts's DDL declares a column that no
// migration file also declares -- unless it is explicitly listed as a
// known, already-accepted gap.
//
// This deliberately checks only one direction (db/index.ts -> migrations).
// A column a migration declares that db/index.ts's CREATE TABLE does not
// would mean db/index.ts's "source of truth" is itself out of date, which
// is a different (and so far unseen) failure mode this test does not cover.

/** Explicitly accepted pre-existing gaps: a (table, column) pair that
 *  db/index.ts's DDL declares but no migrations/*.sql file does. Each entry
 *  here is a real, already-shipped drift, not a way to silence a new one --
 *  adding to this list should come with the same justification a code
 *  comment would need.
 *
 *  todo_routines.default_due_time: added to db/index.ts's CREATE TABLE
 *  alongside a standalone `ALTER TABLE todo_routines ADD COLUMN
 *  default_due_time TEXT` that ensureSchema() runs outside its DDL batch
 *  (see db/index.ts) -- but no matching migration file was ever written.
 *  Confirmed via a direct read against production D1
 *  (`wrangler d1 execute DB --remote`) that the column already exists
 *  there, so this is a documentation gap only, not a live data-integrity
 *  risk -- backfilling a migration for it now would still need SQLite's
 *  missing `ADD COLUMN IF NOT EXISTS` worked around (e.g. checking
 *  pragma_table_info first), which isn't worth the risk for a column
 *  every database already has. See Issue #78. */
const KNOWN_GAPS = new Set(["todo_routines.default_due_time"]);

/** Finds the index of the `)` that closes the `(` at `openIndex`, honoring
 *  nesting and single-quoted string literals (SQLite uses '' to escape a
 *  quote inside a string, which this treats as two adjacent literals --
 *  fine here since it never changes which quote is unmatched). */
function findMatchingParen(text, openIndex) {
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === "'") inString = false;
      continue;
    }
    if (char === "'") inString = true;
    else if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Unbalanced parentheses starting at index ${openIndex}`);
}

/** Splits a CREATE TABLE's column-and-constraint list on top-level commas
 *  only -- not ones nested inside a CHECK(...)'s IN (...) list or a
 *  FOREIGN KEY(...) clause. */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (inString) {
      if (char === "'") inString = false;
      continue;
    }
    if (char === "'") inString = true;
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

const TABLE_CONSTRAINT_KEYWORDS = new Set(["FOREIGN", "PRIMARY", "UNIQUE", "CHECK", "CONSTRAINT"]);

/** Extracts { tableName: Set<columnName> } from every
 *  `CREATE TABLE IF NOT EXISTS <name> (...)` in `sql`, plus every column
 *  named by an `ALTER TABLE <name> ADD COLUMN <column>` in it. */
function extractTableColumns(sql) {
  const tables = new Map();
  const createRe = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/g;
  for (const match of sql.matchAll(createRe)) {
    const tableName = match[1];
    const openIndex = match.index + match[0].length - 1;
    const closeIndex = findMatchingParen(sql, openIndex);
    const body = sql.slice(openIndex + 1, closeIndex);
    const columns = tables.get(tableName) ?? new Set();
    for (const part of splitTopLevel(body)) {
      const firstWord = part.match(/^"?(\w+)"?/)?.[1];
      if (!firstWord) continue;
      if (TABLE_CONSTRAINT_KEYWORDS.has(firstWord.toUpperCase())) continue;
      columns.add(firstWord);
    }
    tables.set(tableName, columns);
  }
  const alterRe = /ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/g;
  for (const match of sql.matchAll(alterRe)) {
    const [, tableName, columnName] = match;
    const columns = tables.get(tableName) ?? new Set();
    columns.add(columnName);
    tables.set(tableName, columns);
  }
  return tables;
}

/** Strips `-- ...` line comments before parsing -- migrations/*.sql use
 *  them for the "why" prose above each statement (see e.g.
 *  migrations/0004_dedupe_asset_snapshots.sql), and none of them contain
 *  anything a naive strip could misparse (no "--" appears inside a string
 *  literal in this codebase's schema). */
function stripLineComments(sql) {
  return sql.replace(/--.*$/gm, "");
}

test("every column db/index.ts's DDL declares also appears in migrations/*.sql, apart from documented gaps", async () => {
  const dbIndexSql = await readFile(new URL("../db/index.ts", import.meta.url), "utf8");
  const dbIndexTables = extractTableColumns(dbIndexSql);
  assert.ok(dbIndexTables.size > 10, "sanity check: expected many tables to be parsed out of db/index.ts");

  const migrationsDir = new URL("../migrations/", import.meta.url);
  const migrationFiles = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql"));
  assert.ok(migrationFiles.length > 0, "sanity check: expected at least one migration file");

  const migrationsTables = new Map();
  for (const file of migrationFiles) {
    const sql = stripLineComments(await readFile(new URL(file, migrationsDir), "utf8"));
    for (const [tableName, columns] of extractTableColumns(sql)) {
      const existing = migrationsTables.get(tableName) ?? new Set();
      for (const column of columns) existing.add(column);
      migrationsTables.set(tableName, existing);
    }
  }

  const missing = [];
  for (const [tableName, columns] of dbIndexTables) {
    const migrationColumns = migrationsTables.get(tableName) ?? new Set();
    for (const column of columns) {
      const key = `${tableName}.${column}`;
      if (!migrationColumns.has(column) && !KNOWN_GAPS.has(key)) missing.push(key);
    }
  }
  assert.deepEqual(
    missing,
    [],
    "db/index.ts declares columns with no matching migrations/*.sql entry -- add a migration, " +
      "or if this is an intentional pre-existing gap, add it to KNOWN_GAPS with the same " +
      "justification a code comment would need",
  );
});

test("extractTableColumns correctly separates columns from table-level constraints", () => {
  const sql = `CREATE TABLE IF NOT EXISTS widgets (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    FOREIGN KEY(owner_id) REFERENCES owners(id),
    CHECK(status IN ('open', 'closed'))
  );`;
  const tables = extractTableColumns(sql);
  assert.deepEqual([...tables.get("widgets")].sort(), ["id", "owner_id", "status"]);
});

test("extractTableColumns handles a single-line CREATE TABLE with nested commas in CHECK/IN", () => {
  const sql = "CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, content_type TEXT NOT NULL, CHECK(content_type IN ('text','audio','movie','other')));";
  const tables = extractTableColumns(sql);
  assert.deepEqual([...tables.get("items")].sort(), ["content_type", "id"]);
});

test("extractTableColumns picks up ALTER TABLE ADD COLUMN", () => {
  const sql = "ALTER TABLE todo_routines ADD COLUMN default_due_time TEXT";
  const tables = extractTableColumns(sql);
  assert.ok(tables.get("todo_routines").has("default_due_time"));
});
