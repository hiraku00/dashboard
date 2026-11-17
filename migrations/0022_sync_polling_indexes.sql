-- Mac 側 collector が60秒ごとに読む GET /api/manage-asset/sync のための索引。
-- 「最新の同期」(received_at の新しい順に1行)と「未処理の再取得依頼」を、全行を読まずに引けるようにする。
-- 同じ内容が db/index.ts の ensureSchema()(schema version 19)にもある。
CREATE INDEX IF NOT EXISTS asset_sync_runs_received_idx ON asset_sync_runs(received_at DESC);
CREATE INDEX IF NOT EXISTS asset_resync_requests_pending_idx ON asset_resync_requests(requested_at DESC) WHERE fulfilled_at IS NULL;
