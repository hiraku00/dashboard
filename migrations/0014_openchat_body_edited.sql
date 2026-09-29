-- OCRの読み間違いを、詳細画面で手で直せるようにする。直した本文は body_edited = 1 にして、
-- collector の再同期(INSERT ... ON CONFLICT DO UPDATE)で OCR の本文に戻されないようにする。
ALTER TABLE openchat_notes ADD COLUMN body_edited INTEGER NOT NULL DEFAULT 0;
ALTER TABLE openchat_comments ADD COLUMN body_edited INTEGER NOT NULL DEFAULT 0;
