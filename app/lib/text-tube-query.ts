/** Pure decision logic for the TextTube video list's read path -- no D1, no
 *  I/O. Kept separate from app/lib/queries/text-tube.ts (which does the
 *  actual D1 calls) for the same reason as app/lib/watch-list-query.ts: a
 *  module that imports "cloudflare:workers" at the top level cannot be
 *  loaded outside the Workers runtime at all, let alone unit tested under
 *  vitest's plain-Node "node" project. */

// Deliberately not importing app/lib/text.ts's clean() here -- see the
// matching comment in app/lib/watch-list-query.ts for why. Keep in sync with
// clean() in app/lib/text.ts.
function clean(value: unknown, max = 4000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export type VideosQuery = { q?: string | null };
export type VideosFilter = { where: string; values: string[] };

/** app/api/text-tube/videos の GET と、/text-tube・/text-tube/studio の
 *  初期表示が両方これを経由する（listVideos() 経由）。q以外のフィルタは
 *  無く、ページネーションも無い（呼び出し元のSQLに固定 LIMIT 100 がある）
 *  ので、ここでの仕事はWHERE句の組み立てだけ。 */
export function buildVideosFilter(query: VideosQuery = {}): VideosFilter {
  const q = clean(query.q, 200);
  if (!q) return { where: "WHERE deleted_at IS NULL", values: [] };
  return {
    where: "WHERE deleted_at IS NULL AND (title LIKE ? OR channel_name LIKE ?)",
    values: [`%${q}%`, `%${q}%`],
  };
}
