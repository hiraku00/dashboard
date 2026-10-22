-- D1 のテーブルごとの容量の概算(値の長さの合計)と行数を、1日1回記録する(app/lib/d1-table-usage.ts)。
-- 使用量画面の「主な保存データ」の容量と増え方に使う。同じ内容が db/index.ts の ensureSchema()(schema version 16)にもある。
CREATE TABLE IF NOT EXISTS d1_table_usage_daily (
  usage_date TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  payload_bytes INTEGER NOT NULL DEFAULT 0,
  measured_at TEXT NOT NULL,
  PRIMARY KEY (usage_date, table_name)
);
