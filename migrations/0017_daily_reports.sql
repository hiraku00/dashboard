-- 作業日報(auto-daily-report)の取り込み(docs/daily-report-ingest-design.md §3)。
-- 原本の Markdown は daily_reports.markdown に置き、R2 は使わない。正規化とタグのテーブルは、
-- 取り込みのたびにその日付の分を作り直す。同じ内容が db/index.ts の ensureSchema()(schema version 13)にもある。
CREATE TABLE IF NOT EXISTS daily_reports (
  report_date TEXT PRIMARY KEY,
  markdown TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  record_start TEXT,
  record_end TEXT,
  recorded_minutes INTEGER,
  capture_count INTEGER,
  capture_count_is_min INTEGER NOT NULL DEFAULT 0,
  gap_minutes INTEGER NOT NULL DEFAULT 0,
  parser_version INTEGER NOT NULL,
  parse_status TEXT NOT NULL,
  parse_warnings TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(parse_status IN ('ok','partial','failed'))
);

-- 内容が変わった再送のときに、差し替えられる前の原本を残す(集計には使わない)
CREATE TABLE IF NOT EXISTS daily_report_revisions (
  report_date TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  markdown TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  replaced_at TEXT NOT NULL,
  PRIMARY KEY (report_date, revision_number)
);

CREATE TABLE IF NOT EXISTS daily_report_work_items (
  report_date TEXT NOT NULL,
  position INTEGER NOT NULL,
  category_position INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  item_position INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (report_date, position)
);

CREATE TABLE IF NOT EXISTS daily_report_app_usage (
  report_date TEXT NOT NULL,
  position INTEGER NOT NULL,
  app_name TEXT NOT NULL,
  app_key TEXT NOT NULL,
  usage_count INTEGER,
  usage_count_raw TEXT NOT NULL DEFAULT '',
  usage_is_min INTEGER NOT NULL DEFAULT 0,
  purpose TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (report_date, position)
);
CREATE INDEX IF NOT EXISTS daily_report_app_usage_key_idx ON daily_report_app_usage(app_key, report_date);

CREATE TABLE IF NOT EXISTS daily_report_time_blocks (
  report_date TEXT NOT NULL,
  position INTEGER NOT NULL,
  start_minute INTEGER,
  end_minute INTEGER,
  activity TEXT NOT NULL,
  duration_minutes INTEGER,
  is_gap INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (report_date, position)
);

CREATE TABLE IF NOT EXISTS daily_report_notes (
  report_date TEXT NOT NULL,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (report_date, position)
);

CREATE TABLE IF NOT EXISTS daily_report_item_tags (
  report_date TEXT NOT NULL,
  source TEXT NOT NULL,
  position INTEGER NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (report_date, source, position, tag),
  CHECK(source IN ('work','time'))
);
CREATE INDEX IF NOT EXISTS daily_report_item_tags_tag_idx ON daily_report_item_tags(tag, report_date);

-- 1日×タグの合計。週・月の集計はこの表の SUM だけで済ませる
CREATE TABLE IF NOT EXISTS daily_report_tag_days (
  report_date TEXT NOT NULL,
  tag TEXT NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 0,
  work_item_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (report_date, tag)
);
