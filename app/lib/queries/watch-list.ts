/** Watch List の読み取りロジック（D1呼び出しを伴うオーケストレーション層）。
 *  app/api/items 系のルートハンドラと、Watch List ページの Server Component
 *  の両方がこれを呼ぶ -- ロジックを複製すると「ページとAPIで表示件数が
 *  ずれる」種類のバグを作るので、正はここに一本化する。
 *
 *  純粋な決定ロジック（WHERE句の組み立て、行のマッピング）は
 *  app/lib/watch-list-query.ts に分離してある。ここで cloudflare:workers を
 *  importすると、その関数群を plain Node (`node --test`) でユニットテスト
 *  できなくなるため。
 *
 *  書き込み系 (POST/PATCH/DELETE や normalizeItem) はここには置かない。
 *  app/api/items/route.ts と app/api/items/[id]/route.ts に残したまま。 */
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { buildItemsFilter, toItem, type ListItemsQuery, type WatchListItem } from "@/app/lib/watch-list-query";

export type { ListItemsQuery, WatchListItem };

/** POST/PATCH も保存直後の1件表示にこれを使う。id複数件バインドは
 *  IN (?,?,...) をチャンク化していない -- 呼び出し元はどちらも
 *  一覧ページ由来の最大100件か保存直後の1件で、SQLiteの100変数上限に
 *  達しない。 */
export async function attachLinks(rows: Array<Record<string, unknown>>): Promise<WatchListItem[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id as string);
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(`SELECT * FROM item_links WHERE item_id IN (${placeholders}) ORDER BY position ASC`).bind(...ids).all<Record<string, unknown>>();
  const byItem = new Map<string, Array<Record<string, unknown>>>();
  for (const link of results ?? []) {
    const itemId = String(link.item_id);
    byItem.set(itemId, [...(byItem.get(itemId) ?? []), link]);
  }
  return rows.map((row) => toItem(row, byItem.get(String(row.id)) ?? []));
}

export type ListItemsResult = {
  items: WatchListItem[];
  pagination: { total: number; limit: number; offset: number; hasMore: boolean };
};

/** app/api/items の GET と、Watch List ページの初期表示が両方呼ぶ。 */
export async function listItems(query: ListItemsQuery = {}): Promise<ListItemsResult> {
  await ensureSchema();
  const { where, values, limit, offset } = buildItemsFilter(query);
  const [rows, totalResult] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM items ${where} ORDER BY added_on IS NULL ASC, added_on DESC, created_at DESC LIMIT ? OFFSET ?`).bind(...values, limit, offset),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM items ${where}`).bind(...values),
  ]);
  const results = rows.results as Array<Record<string, unknown>> | undefined;
  const items = await attachLinks(results ?? []);
  const total = Number((totalResult.results?.[0] as { count?: number } | undefined)?.count ?? 0);
  return { items, pagination: { total, limit, offset, hasMore: offset + items.length < total } };
}

export type WatchListStats = { total: number; completed: number; movie: number; audio: number; text: number };

/** app/api/stats の GET と、Watch List ページの初期表示が両方呼ぶ。 */
export async function watchListStats(): Promise<WatchListStats> {
  await ensureSchema({ seed: false });
  const [total, completed, movie, audio, text] = await env.DB.batch<{ count: number }>([
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL AND status='completed'"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL AND content_type='movie'"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL AND content_type='audio'"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL AND content_type='text'"),
  ]);
  const count = (result: D1Result<{ count: number }>) => Number(result.results?.[0]?.count ?? 0);
  return { total: count(total), completed: count(completed), movie: count(movie), audio: count(audio), text: count(text) };
}
