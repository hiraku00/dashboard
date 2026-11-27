-- モーニングページのヘッダーの表「服装」(`上:シャツ(Uniqlo U)<br>中:Tシャツ(WhitesVille)<br>下:デニム(白)`)を、上・中・下の段ごとに
-- 書いたままの値で持つ。服装の欄が無いページ・書かなかった段は空文字。auto-daily-report の morning_pages.py が送る。
-- 同じ内容が db/index.ts の ensureSchema()(schema version 24)にもある。
ALTER TABLE morning_pages ADD COLUMN outfit_top TEXT NOT NULL DEFAULT '';
ALTER TABLE morning_pages ADD COLUMN outfit_middle TEXT NOT NULL DEFAULT '';
ALTER TABLE morning_pages ADD COLUMN outfit_bottom TEXT NOT NULL DEFAULT '';
