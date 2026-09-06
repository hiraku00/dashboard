-- Backfills three tables that db/index.ts's ensureSchema() has created since
-- before this migrations/ directory covered them, but that never got a
-- migration file: asset_history_records, asset_lido_rewards, asset_fx_rates.
-- Found by tests/schema-parity.test.mjs (Issue #78), which parses db/index.ts
-- and migrations/*.sql and diffs their declared columns per table -- these
-- three tables showed up in db/index.ts with zero matching migration at all.
--
-- Safe to apply to a database that already has these tables (via
-- ensureSchema()'s own CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
-- EXISTS, which every deploy already runs): every statement here is
-- idempotent, unlike an ALTER TABLE ADD COLUMN would be.

CREATE TABLE IF NOT EXISTS asset_history_records (
  id TEXT PRIMARY KEY, record_type TEXT NOT NULL, source_id TEXT NOT NULL DEFAULT '',
  as_of_date TEXT NOT NULL, captured_at TEXT NOT NULL, total_usd REAL NOT NULL DEFAULT 0,
  total_jpy REAL NOT NULL DEFAULT 0, fx_usdjpy REAL, payload_json TEXT NOT NULL,
  UNIQUE(record_type, source_id, as_of_date, captured_at)
);
CREATE INDEX IF NOT EXISTS asset_history_records_date_idx ON asset_history_records(record_type, as_of_date DESC);

CREATE TABLE IF NOT EXISTS asset_lido_rewards (
  id TEXT PRIMARY KEY, reward_date TEXT NOT NULL, reward_type TEXT NOT NULL DEFAULT 'reward',
  change REAL, change_usd REAL, apr REAL, balance REAL, payload_json TEXT NOT NULL,
  UNIQUE(reward_date, reward_type, change, balance)
);
CREATE INDEX IF NOT EXISTS asset_lido_rewards_date_idx ON asset_lido_rewards(reward_date DESC);

CREATE TABLE IF NOT EXISTS asset_fx_rates (
  rate_date TEXT PRIMARY KEY, rate REAL NOT NULL, payload_json TEXT NOT NULL
);
