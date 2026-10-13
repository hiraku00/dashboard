-- データ更新画面の「今すぐ再取得」ボタンが書く依頼。ポータルはAPIキーを持たないため、
-- ここに書けるのは「依頼した事実」だけ。Mac側collectorが自分のlaunchdティックで
-- 未処理行を見つけて全source再取得し、fulfilled_atを立てて消化する。
CREATE TABLE IF NOT EXISTS asset_resync_requests (
  id TEXT PRIMARY KEY,
  requested_at TEXT NOT NULL,
  fulfilled_at TEXT
);
