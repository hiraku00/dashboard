/** TextTube の一覧の状態（検索語・並び順・チャンネル・未読のみ）と、URL のクエリとの行き来。
 *
 *  I/O の無い純粋な関数だけを置く。サーバーの app/text-tube/page.tsx と、クライアントの
 *  app/text-tube-app.tsx の両方が使うので、"use client" のファイルには置けない
 *  （そこから export した関数は、サーバーからは呼べない）。 */
import { MAX_LIKE_TERM_BYTES, truncateUtf8Bytes } from "./sql-text.ts";

/** 一覧の絞り込みと並び順。URL のクエリ(`?q=&sort=&channel=&unread=1`)と行き来する。 */
export type ListView = { q: string; sort: string; channel: string; unread: boolean };
export const DEFAULT_SORT = "created_at-desc";
const SORTS = new Set([DEFAULT_SORT, "view_count-desc", "created_at-asc", "title-asc"]);
/** URL のクエリから一覧の状態を読む。知らない並び順は既定に戻す。サーバー(page.tsx)とクライアントの両方が使う。 */
export function listViewFromParams(params: { q?: string | null; sort?: string | null; channel?: string | null; unread?: string | null }): ListView {
  return {
    q: truncateUtf8Bytes((params.q ?? "").trim(), MAX_LIKE_TERM_BYTES),
    sort: params.sort && SORTS.has(params.sort) ? params.sort : DEFAULT_SORT,
    channel: params.channel?.trim() || "all",
    unread: params.unread === "1",
  };
}
/** 一覧の状態を URL のクエリにする。既定値は書かない（何も絞っていなければ空）。 */
export function listViewQuery(view: ListView): string {
  const params = new URLSearchParams();
  if (view.q) params.set("q", view.q);
  if (view.sort !== DEFAULT_SORT) params.set("sort", view.sort);
  if (view.channel !== "all") params.set("channel", view.channel);
  if (view.unread) params.set("unread", "1");
  const query = params.toString();
  return query ? `?${query}` : "";
}
