-- 一覧が全スレッドを出すようになったため、絞り込みなし(kind=all)でも使えるインデックスを足す。
-- 既存の openchat_notes_target_idx(ちきりんが関わるスレッドだけの絞り込み用)はそのまま残す。
CREATE INDEX IF NOT EXISTS openchat_notes_room_posted_idx
  ON openchat_notes(room, posted_at DESC) WHERE deleted_at IS NULL;
