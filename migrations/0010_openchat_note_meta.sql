-- ちきりんオプチャ: 人が後から編集する情報(放送局・その日の放送タイトル・リンク)。
-- collector が読み取るデータ(openchat_notes)とは別のテーブルにして、同期で上書きされないようにする。
CREATE TABLE IF NOT EXISTS openchat_note_meta (
  note_id TEXT PRIMARY KEY REFERENCES openchat_notes(id) ON DELETE CASCADE,
  broadcaster TEXT NOT NULL DEFAULT '',
  episode_title TEXT NOT NULL DEFAULT '',
  links_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
