-- Records which version of ensureSchema()'s DDL a database has been
-- provisioned with, so the ~40 CREATE TABLE / CREATE INDEX statements can be
-- skipped once they have run.
--
-- ensureSchema() is called at the start of nearly every route and its
-- "already done" flag is a module-level variable, which is per-isolate. Every
-- new isolate's first request therefore re-ran the whole batch. On an
-- already-provisioned database each statement is a no-op, but D1 still counts
-- each one as a write query against the daily quota. A single-row read of this
-- table replaces all of them.
--
-- Applying this migration is optional: ensureSchema() creates the table itself
-- (it is the first statement in its batch) and records the version once the
-- rest of the DDL succeeds, so the first request after deploy provisions it.
-- It is here so that migrations/ stays a complete account of the schema, as
-- docs/data-model.md requires.

CREATE TABLE IF NOT EXISTS schema_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
