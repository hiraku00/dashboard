-- 作業日報の週次・月次サマリ(auto-daily-report の summarize.py が作る Markdown)の取り込み
-- (docs/daily-report-ingest-design.md §10)。日報と違い解析・タグ付けはせず、原本をそのまま置く。
-- 週は月曜〜日曜、月は1日〜末日。同じ内容が db/index.ts の ensureSchema()(schema version 14)にもある。
CREATE TABLE IF NOT EXISTS daily_report_summaries (
  kind TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  markdown TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, period_start),
  CHECK(kind IN ('week','month'))
);
