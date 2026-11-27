-- モーニングページのヘッダーの表「服装」(`上:ストライプシャツ (UNIQLO)<br>中:Tシャツ (WHITESVILLE)<br>下:白デニム (UNIQLO)`)を、
-- 上・中・下の段ごとに品名(outfit_*)と末尾の括弧のブランド(outfit_*_brand)に分けて持つ。
-- 服装の欄が無いページ・書かなかった段・括弧の無い値のブランドは空文字。auto-daily-report の morning_pages.py が送る。
-- 同じ内容が db/index.ts の ensureSchema()(schema version 24)にもある。
ALTER TABLE morning_pages ADD COLUMN outfit_top TEXT NOT NULL DEFAULT '';
ALTER TABLE morning_pages ADD COLUMN outfit_top_brand TEXT NOT NULL DEFAULT '';
ALTER TABLE morning_pages ADD COLUMN outfit_middle TEXT NOT NULL DEFAULT '';
ALTER TABLE morning_pages ADD COLUMN outfit_middle_brand TEXT NOT NULL DEFAULT '';
ALTER TABLE morning_pages ADD COLUMN outfit_bottom TEXT NOT NULL DEFAULT '';
ALTER TABLE morning_pages ADD COLUMN outfit_bottom_brand TEXT NOT NULL DEFAULT '';
