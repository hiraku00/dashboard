-- ちきりんオプチャ(LINEオープンチャット「集まれテレビっ子」のノート)。
-- collector/line_openchat が読み取ったノートとコメントを保存する。設計は
-- docs/chikirin-openchat.md。
--
-- 画面(/chikirin)に出すのは、ちきりんが立てたノートの本文と、ちきりんの
-- コメントだけ。ほかの人の投稿(本文を含む)も保存するのは、collectorが「取得済みか」
-- を判定するための台帳を失ったときに復元できるようにするため。APIの一覧には返さない。
--
-- idはcollectorが発行したUUID。OCRの揺れで同じ投稿を2回数えないよう、照合はcollector側で
-- 行い、ここへは確定したIDで送ってくる(INSERT ... ON CONFLICT(id) DO UPDATE で冪等)。

CREATE TABLE IF NOT EXISTS openchat_notes (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_is_target INTEGER NOT NULL DEFAULT 0,
  program_title TEXT NOT NULL DEFAULT '',
  link_title TEXT NOT NULL DEFAULT '',
  link_url TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  body_complete INTEGER NOT NULL DEFAULT 0,
  posted_at TEXT NOT NULL,
  posted_at_precision TEXT NOT NULL,
  posted_at_raw TEXT NOT NULL DEFAULT '',
  comment_count INTEGER NOT NULL DEFAULT 0,
  target_comment_count INTEGER NOT NULL DEFAULT 0,
  needs_recheck INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_checked_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK(posted_at_precision IN ('exact','approx_min','approx_hour'))
);

CREATE INDEX IF NOT EXISTS openchat_notes_target_idx
  ON openchat_notes(room, posted_at DESC)
  WHERE deleted_at IS NULL AND (author_is_target = 1 OR target_comment_count > 0);

CREATE TABLE IF NOT EXISTS openchat_comments (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  author_name TEXT NOT NULL,
  is_target INTEGER NOT NULL DEFAULT 0,
  body_text TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  posted_at_precision TEXT NOT NULL,
  posted_at_raw TEXT NOT NULL DEFAULT '',
  ocr_min_confidence REAL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK(posted_at_precision IN ('exact','approx_min','approx_hour'))
);

CREATE INDEX IF NOT EXISTS openchat_comments_note_idx ON openchat_comments(note_id, ordinal);

CREATE INDEX IF NOT EXISTS openchat_comments_target_idx
  ON openchat_comments(note_id, posted_at)
  WHERE is_target = 1 AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS openchat_sync_runs (
  id TEXT PRIMARY KEY,
  client_run_id TEXT NOT NULL UNIQUE,
  client_version TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  notes_scanned INTEGER NOT NULL DEFAULT 0,
  notes_opened INTEGER NOT NULL DEFAULT 0,
  comments_new INTEGER NOT NULL DEFAULT 0,
  target_comments_new INTEGER NOT NULL DEFAULT 0,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  CHECK(status IN ('started','success','partial','failed','aborted'))
);
