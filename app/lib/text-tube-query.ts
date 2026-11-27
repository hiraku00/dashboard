/** Pure decision logic for the TextTube video list's read path -- no D1, no
 *  I/O. Kept separate from app/lib/queries/text-tube.ts (which does the
 *  actual D1 calls) for the same reason as app/lib/watch-list-query.ts: a
 *  module that imports "cloudflare:workers" at the top level cannot be
 *  loaded outside the Workers runtime at all, let alone unit tested under
 *  vitest's plain-Node "node" project. */
import { MAX_LIKE_TERM_BYTES, truncateUtf8Bytes } from "./sql-text.ts";

// Deliberately not importing app/lib/text.ts's clean() here -- see the
// matching comment in app/lib/watch-list-query.ts for why. Keep in sync with
// clean() in app/lib/text.ts.
function clean(value: unknown, max = 4000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export type VideosQuery = {
  q?: string | null;
  offset?: string | number | null;
  /** true なら未読（read_at が NULL）だけ。 */
  unread?: boolean;
  /** チャンネル名（完全一致）。空・"all" なら絞らない。 */
  channel?: string | null;
};

/** `?channel=` の値。空と "all"（画面の「すべてのチャンネル」）は「絞らない」として "" にする。 */
export function videosChannel(value: unknown): string {
  const channel = clean(value, 200);
  return channel === "all" ? "" : channel;
}

/** `?unread=` の値。"1" だけを「未読のみ」として扱う。 */
export function videosUnread(value: unknown): boolean {
  return value === "1" || value === true;
}

/** 一覧が1回に返す本数。続きは offset を付けて読む（画面の「さらに読み込む」）。 */
export const VIDEOS_PAGE_SIZE = 100;

/** `?offset=` の値を、0以上の整数にする。数でないもの・負の数は先頭（0）として扱う。 */
export function videosOffset(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d{1,9}$/.test(value.trim()) ? Number(value.trim()) : 0;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}
export type VideosFilter = { where: string; values: string[] };

/** app/api/text-tube/videos の GET と、/text-tube の
 *  初期表示が両方これを経由する（listVideos() 経由）。ここでの仕事はWHERE句の組み立てだけ
 *  （続きの読み込みは呼び出し元のSQLが VIDEOS_PAGE_SIZE と videosOffset() で行う）。
 *  チャンネルはサーバーで絞る -- 画面側で絞ると、読み込んだ先頭の100本に入っていない回が出ない。 */
export function buildVideosFilter(query: VideosQuery = {}): VideosFilter {
  const base = buildChannelsFilter(query);
  const channel = videosChannel(query.channel);
  if (!channel) return base;
  return { where: `${base.where} AND channel_name = ?`, values: [...base.values, channel] };
}

/** チャンネルの選択肢（チャンネルごとの本数）を数えるときのWHERE句。検索語と未読のみは効かせ、
 *  チャンネルの絞り込みだけは外す -- 外さないと、選んだチャンネルしか選択肢に残らない。 */
export function buildChannelsFilter(query: VideosQuery = {}): VideosFilter {
  // Truncated to a byte-safe length in addition to clean()'s 200-JS-char cap --
  // see sql-text.ts for why: a longer term inside `%${q}%` makes D1 reject the
  // whole query rather than just matching fewer rows.
  const q = truncateUtf8Bytes(clean(query.q, 200), MAX_LIKE_TERM_BYTES);
  const unread = query.unread ? " AND read_at IS NULL" : "";
  if (!q) return { where: `WHERE deleted_at IS NULL${unread}`, values: [] };
  return {
    where: `WHERE deleted_at IS NULL${unread} AND (title LIKE ? OR channel_name LIKE ?)`,
    values: [`%${q}%`, `%${q}%`],
  };
}
