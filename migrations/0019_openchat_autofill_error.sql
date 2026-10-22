-- 放送情報の自動入力(同期の完了時)で、リンク先のページを読めなかった理由。「HTTP 403(3回)」「時間切れ(8秒)」「例外: …」など。
-- その場で取り直したときは「1回目: … / 2回目: …」。1回で読めたら空。
ALTER TABLE openchat_note_meta ADD COLUMN autofill_error TEXT NOT NULL DEFAULT '';
