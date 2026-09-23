-- Watch ListにYouTubeリンクを保存すると、TextTubeへ動画・字幕を自動で
-- 取り込む機能(app/lib/text-tube-import.ts)の実行記録テーブル。
--
-- 1つのyoutube_video_idに対して複数行残り得る(失敗後の再試行、
-- TextTube側で削除したあとの再取り込みなど)ため、UNIQUE制約は付けない --
-- 「今の状態」は updated_at が最新の1行で判断する。
--
-- text_tube_videos.youtube_video_id 列(schema version 4)は、この
-- migrationには含めない: SQLiteにはADD COLUMN IF NOT EXISTSが無く、
-- ensureSchema()が既に列を足したDBでこのALTERを流すと「duplicate column」
-- で migrations apply が止まるため(items.thumbnail_url と同じ扱い。
-- tests/schema-parity.test.mjs のKNOWN_GAPSを参照)。列の追加と既存行の
-- バックフィルは db/index.ts の ensureSchema() が行う。

CREATE TABLE IF NOT EXISTS text_tube_imports (
  id TEXT PRIMARY KEY,
  youtube_video_id TEXT NOT NULL,
  item_id TEXT,
  status TEXT NOT NULL,
  video_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT NOT NULL DEFAULT '',
  dismissed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(status IN ('running','done','failed'))
);

CREATE INDEX IF NOT EXISTS text_tube_imports_video_idx
  ON text_tube_imports(youtube_video_id, updated_at DESC);
