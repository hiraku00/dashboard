-- モーニングページ(Obsidian の朝の書き物)の1ページ1行。auto-daily-report の morning_pages.py が送る。
-- ヘッダーの表(時間・場所・文字数)と、Claude で取り出した「昨日のこと・今日の予定・気になったこと」(JSON配列)だけを置き、本文は置かない。
-- 作業日報(daily_reports)とは別の入れ物。画面記録の日報が無い 2025-12-23 より前の期間を中心に、日報が無くても読めるようにする。
-- 同じ内容が db/index.ts の ensureSchema()(schema version 23)にもある。
CREATE TABLE IF NOT EXISTS morning_pages (
  page_date TEXT PRIMARY KEY,
  started_at TEXT,
  ended_at TEXT,
  minutes INTEGER,
  place TEXT NOT NULL DEFAULT '',
  chars INTEGER,
  yesterday TEXT NOT NULL DEFAULT '[]',
  plan TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '[]',
  extracted INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
