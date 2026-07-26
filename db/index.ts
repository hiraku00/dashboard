import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import initialWatchList from "../data/initial-watch-list.example.json";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Check the D1 binding in wrangler.jsonc before using the database."
    );
  }

  return drizzle(env.DB, { schema });
}

let schemaReady = false;

export async function ensureSchema({ seed = true }: { seed?: boolean } = {}) {
  if (schemaReady) return;

  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, content_type TEXT NOT NULL, creator_name TEXT NOT NULL DEFAULT '',
      series_title TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      priority INTEGER, status TEXT NOT NULL DEFAULT 'backlog', added_on TEXT, watched_on TEXT,
      comment TEXT NOT NULL DEFAULT '', source_system TEXT NOT NULL DEFAULT 'manual', external_id TEXT,
      raw_source TEXT, version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT,
      CHECK(content_type IN ('text','audio','movie','other')),
      CHECK(status IN ('backlog','in_progress','completed','dropped')),
      CHECK(priority IS NULL OR priority BETWEEN 1 AND 5)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS item_links (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', url TEXT NOT NULL,
      link_type TEXT NOT NULL DEFAULT 'reference', position INTEGER NOT NULL DEFAULT 0,
      canonical_url TEXT NOT NULL DEFAULT '', FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS import_runs (
      id TEXT PRIMARY KEY, source_name TEXT NOT NULL, total_count INTEGER NOT NULL DEFAULT 0,
      created_count INTEGER NOT NULL DEFAULT 0, updated_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS items_status_idx ON items(status)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS items_type_idx ON items(content_type)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS items_added_on_idx ON items(added_on)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS item_links_item_idx ON item_links(item_id)"),
    env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS items_source_external_idx ON items(source_system, external_id)"),
  ]);
  const countResult = seed ? await env.DB.prepare("SELECT COUNT(*) AS count FROM items").all<{ count: number }>() : null;
  if (seed && Number(countResult?.results?.[0]?.count ?? 0) === 0) {
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    for (const seed of initialWatchList.items) {
      const id = crypto.randomUUID();
      statements.push(env.DB.prepare("INSERT INTO items (id,content_type,creator_name,series_title,title,description,priority,status,added_on,watched_on,comment,source_system,external_id,raw_source,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)")
        .bind(id, seed.contentType, seed.creatorName, seed.seriesTitle, seed.title, seed.description, seed.priority, seed.status, seed.addedOn, seed.watchedOn, seed.comment, seed.sourceSystem, seed.externalId, seed.rawSource, now, now));
      for (const [position, link] of seed.links.entries()) {
        const url = new URL(link.url); url.hash = "";
        statements.push(env.DB.prepare("INSERT INTO item_links (id,item_id,label,url,link_type,position,canonical_url) VALUES (?,?,?,?,?,?,?)")
          .bind(crypto.randomUUID(), id, link.label, link.url, link.linkType, position, url.toString()));
      }
    }
    for (let start = 0; start < statements.length; start += 50) await env.DB.batch(statements.slice(start, start + 50));
  }
  schemaReady = true;
}
