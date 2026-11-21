-- 作業日報の6節目「予定と振り返り」の本文。auto-daily-report が Obsidian のモーニングページ(D 日の予定と D+1 日の振り返り)から
-- 書き足す任意の節で、/daily-report の「振り返り」タブが読む。6節目の無い日報は空文字。
-- 同じ内容が db/index.ts の ensureSchema()(schema version 22)にもある。
ALTER TABLE daily_reports ADD COLUMN reflection TEXT NOT NULL DEFAULT '';
