-- ポータルの設定。今は Manage Asset が既定で表示するウォレット("manage_asset_wallet" = "1" 本番 / "2" ダミーデータ)だけ。
-- 同じ内容が db/index.ts の ensureSchema()(schema version 17)にもある。
CREATE TABLE IF NOT EXISTS portal_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
