CREATE TABLE IF NOT EXISTS text_tube_api_usage (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  operation TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  credits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS text_tube_api_usage_created_idx
  ON text_tube_api_usage(provider, created_at DESC);
