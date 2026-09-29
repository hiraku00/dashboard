-- ちきりんオプチャ一覧のサムネイル。Watch List と同じく、リンク先ページの og:image を一度だけ探して保存する
-- (YouTube はリンクから決まるので保存しない)。放送情報を保存したときに取得する。source_url は画像を探したリンクで、
-- 一覧に出すリンクと違う行は古い画像として使わない。
CREATE TABLE IF NOT EXISTS openchat_note_thumbnails (
  note_id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  thumbnail_url TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL
);
