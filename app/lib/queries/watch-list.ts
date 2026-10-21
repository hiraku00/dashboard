/** Watch List の読み取りロジック（D1呼び出しを伴うオーケストレーション層）。
 *  app/api/items 系のルートハンドラと、Watch List ページの Server Component
 *  の両方がこれを呼ぶ -- ロジックを複製すると「ページとAPIで表示件数が
 *  ずれる」種類のバグを作るので、正はここに一本化する。
 *
 *  純粋な決定ロジック（WHERE句の組み立て、行のマッピング）は
 *  app/lib/watch-list-query.ts に分離してある。ここで cloudflare:workers を
 *  importすると、その関数群を plain Node (vitest's "node" project) でユニットテスト
 *  できなくなるため。
 *
 *  書き込み系 (POST/PATCH/DELETE や normalizeItem) はここには置かない。
 *  app/api/items/route.ts と app/api/items/[id]/route.ts に残したまま。 */
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { buildItemsFilter, ITEMS_ORDER_BY, toItem, attachTextTubeStatus, attachOpenchat, type ListItemsQuery, type OpenchatNoteLinks, type WatchListItem } from "@/app/lib/watch-list-query";
import { youTubeVideoId } from "@/app/lib/youtube";
import { metaFromRow } from "@/app/lib/openchat-meta";
import { ROOM } from "@/app/lib/openchat-query";

export type { ListItemsQuery, WatchListItem };

const STALE_RUNNING_MS = 10 * 60 * 1000;

/** Looks up, for every YouTube video id referenced by `items`' links, the
 *  live (non-deleted) text_tube_videos row and the latest text_tube_imports
 *  row -- then hands both maps to the pure attachTextTubeStatus() (see
 *  app/lib/watch-list-query.ts for the actual status decision). Shared by
 *  attachLinks() and listItems() so a single-item response (just after
 *  save) and the paged list agree on what "reflected"/"running"/"failed"
 *  means, the same reason toItem() itself is shared. A no-op (no extra D1
 *  round trip) when none of `items`' links are YouTube URLs. */
async function withTextTubeStatus(items: WatchListItem[]): Promise<WatchListItem[]> {
  const videoIds = new Set<string>();
  for (const item of items) for (const link of item.links) {
    const id = youTubeVideoId(link.url);
    if (id) videoIds.add(id);
  }
  if (!videoIds.size) return items;
  const ids = [...videoIds];
  const placeholders = ids.map(() => "?").join(",");
  const staleCutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  const [videoResult, importResult] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(`SELECT id, youtube_video_id FROM text_tube_videos WHERE youtube_video_id IN (${placeholders}) AND deleted_at IS NULL`).bind(...ids),
    // 「youtube_video_idごとに最新の1行」を1回の問い合わせで取る --
    // app/lib/text-tube-import.ts の pendingTextTubeImports() と同じ
    // 相関サブクエリでの絞り込み。
    env.DB.prepare(`SELECT ti.* FROM text_tube_imports ti WHERE ti.youtube_video_id IN (${placeholders}) AND ti.updated_at = (SELECT MAX(updated_at) FROM text_tube_imports WHERE youtube_video_id = ti.youtube_video_id)`).bind(...ids),
  ]);
  const videoByYoutubeId = new Map<string, { id: unknown }>();
  for (const row of videoResult.results ?? []) videoByYoutubeId.set(String(row.youtube_video_id), { id: row.id });
  const importByYoutubeId = new Map<string, { status: unknown; last_error?: unknown; updated_at: unknown }>();
  for (const row of importResult.results ?? []) {
    const key = String(row.youtube_video_id);
    if (!importByYoutubeId.has(key)) importByYoutubeId.set(key, row as { status: unknown; last_error?: unknown; updated_at: unknown });
  }
  return attachTextTubeStatus(items, videoByYoutubeId, importByYoutubeId, staleCutoff);
}

/** 「ちきりんオプチャ」列の照合に使う、オプチャの全スレッドとそのリンク(照合は attachOpenchat())。
 *  オプチャのリンクは放送情報の links_json(JSON)にもあってSQLで照合できないので、スレッドを全件読む。
 *  スレッドは数十件の規模(1日に数件増える程度)なので、一覧と同じ batch に入れて往復を増やさないこちらを選んだ。 */
function openchatNotesStatement() {
  return env.DB.prepare(
    `SELECT n.id, n.link_url, n.program_title, m.episode_title, m.links_json
       FROM openchat_notes n LEFT JOIN openchat_note_meta m ON m.note_id = n.id
      WHERE n.room = ? AND n.deleted_at IS NULL`,
  ).bind(ROOM);
}

function toOpenchatNotes(rows: Array<Record<string, unknown>>): OpenchatNoteLinks[] {
  return rows.map((row) => {
    const meta = metaFromRow(row);
    return {
      noteId: String(row.id),
      title: String(row.episode_title || row.program_title || ""),
      urls: [...meta.links.map((l) => l.url), String(row.link_url ?? "")],
      episodeTitle: meta.episodeTitle,
    };
  });
}

/** 「ちきりんオプチャ」列で共有URLを見分けるための、ページの項目が持つリンクの正規化URLごとの、
 *  Watch List 全体(削除済みを除く)でそのURLを持つ項目の数(attachOpenchat() 参照)。
 *  pageItemIds は、ページの項目の id を返すサブクエリか「?,?,…」。 */
function linkItemCountsStatement(pageItemIds: string, values: unknown[]) {
  return env.DB.prepare(
    `SELECT l.canonical_url, COUNT(DISTINCT l.item_id) AS c
       FROM item_links l JOIN items i ON i.id = l.item_id
      WHERE i.deleted_at IS NULL AND l.canonical_url IN (SELECT canonical_url FROM item_links WHERE item_id IN (${pageItemIds}))
      GROUP BY l.canonical_url`,
  ).bind(...values);
}

function toItemCounts(rows: Array<Record<string, unknown>>): Map<string, number> {
  return new Map(rows.map((row) => [String(row.canonical_url), Number(row.c)]));
}

/** POST/PATCH も保存直後の1件表示にこれを使う。id複数件バインドは
 *  IN (?,?,...) をチャンク化していない -- 呼び出し元はどちらも
 *  一覧ページ由来の最大100件か保存直後の1件で、SQLiteの100変数上限に
 *  達しない。 */
export async function attachLinks(rows: Array<Record<string, unknown>>): Promise<WatchListItem[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id as string);
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(`SELECT * FROM item_links WHERE item_id IN (${placeholders}) ORDER BY position ASC`).bind(...ids).all<Record<string, unknown>>();
  const byItem = groupLinksByItem(results ?? []);
  const items = rows.map((row) => toItem(row, byItem.get(String(row.id)) ?? []));
  const [withStatus, [openchat, itemCounts]] = await Promise.all([withTextTubeStatus(items), env.DB.batch([openchatNotesStatement(), linkItemCountsStatement(placeholders, ids)])]);
  return attachOpenchat(withStatus, toOpenchatNotes((openchat.results ?? []) as Array<Record<string, unknown>>), toItemCounts((itemCounts.results ?? []) as Array<Record<string, unknown>>));
}

function groupLinksByItem(links: Array<Record<string, unknown>>) {
  const byItem = new Map<string, Array<Record<string, unknown>>>();
  for (const link of links) {
    const itemId = String(link.item_id);
    const group = byItem.get(itemId);
    if (group) group.push(link);
    else byItem.set(itemId, [link]);
  }
  return byItem;
}

export type ListItemsResult = {
  items: WatchListItem[];
  pagination: { total: number; limit: number; offset: number; hasMore: boolean };
};

/** app/api/items の GET と、Watch List ページの初期表示が両方呼ぶ。
 *
 *  一覧・総数・リンク・オプチャの照合用スレッド・共有URLの項目数を D1 への1往復（1回の batch）で取る。以前はリンクを
 *  一覧の取得後に別の問い合わせで引いており、ページ送りのたびに D1 へ
 *  2往復していた（D1 の1往復は SQL 自体の実行より桁違いに長い）。リンクは
 *  ページ内の id をまだ知らないので、一覧と同じ WHERE / ORDER BY / LIMIT の
 *  サブクエリで絞る。ORDER BY が id まで決め切っているので、両者は必ず
 *  同じ行を選ぶ。 */
export async function listItems(query: ListItemsQuery = {}): Promise<ListItemsResult> {
  await ensureSchema();
  const { where, values, limit, offset } = buildItemsFilter(query);
  const page = `SELECT id FROM items ${where} ${ITEMS_ORDER_BY} LIMIT ? OFFSET ?`;
  const [rows, totalResult, linkResult, openchatResult, itemCountResult] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM items ${where} ${ITEMS_ORDER_BY} LIMIT ? OFFSET ?`).bind(...values, limit, offset),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM items ${where}`).bind(...values),
    env.DB.prepare(`SELECT * FROM item_links WHERE item_id IN (${page}) ORDER BY position ASC`).bind(...values, limit, offset),
    openchatNotesStatement(),
    linkItemCountsStatement(page, [...values, limit, offset]),
  ]);
  const linksByItem = groupLinksByItem((linkResult.results ?? []) as Array<Record<string, unknown>>);
  const rawItems = ((rows.results ?? []) as Array<Record<string, unknown>>).map((row) => toItem(row, linksByItem.get(String(row.id)) ?? []));
  const items = attachOpenchat(await withTextTubeStatus(rawItems), toOpenchatNotes((openchatResult.results ?? []) as Array<Record<string, unknown>>), toItemCounts((itemCountResult.results ?? []) as Array<Record<string, unknown>>));
  const total = Number((totalResult.results?.[0] as { count?: number } | undefined)?.count ?? 0);
  return { items, pagination: { total, limit, offset, hasMore: offset + items.length < total } };
}

export type WatchListStats = {
  total: number; completed: number; movie: number; audio: number; text: number;
  byStatus: { backlog: number; in_progress: number; completed: number; dropped: number };
  /** 削除されていない項目の人物・媒体(空は除く)を重複なしで五十音順に。「人物・媒体」の絞り込みの選択肢に使う
   *  (表示中のページの10件から作ると、他のページにしかいない人物を選べなかった)。 */
  creators: string[];
};

/** app/api/stats の GET と、Watch List ページの初期表示が両方呼ぶ。
 *  件数は1本の集計(COUNT + SUM(CASE…))で取る。以前は条件ごとに5本の COUNT を投げており、
 *  そのたびに items を読み直して D1 の読み取り行数が5倍になっていた。人物の一覧と合わせて1回の batch で取る。
 *  並べ替えは日本語の読み順にしたいので SQL ではなく JS(localeCompare(…, "ja"))で行う。 */
export async function watchListStats(): Promise<WatchListStats> {
  await ensureSchema({ seed: false });
  const [counts, creators] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN status='backlog' THEN 1 ELSE 0 END) AS backlog,
        SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status='dropped' THEN 1 ELSE 0 END) AS dropped,
        SUM(CASE WHEN content_type='movie' THEN 1 ELSE 0 END) AS movie,
        SUM(CASE WHEN content_type='audio' THEN 1 ELSE 0 END) AS audio,
        SUM(CASE WHEN content_type='text' THEN 1 ELSE 0 END) AS text
      FROM items WHERE deleted_at IS NULL`),
    env.DB.prepare("SELECT DISTINCT creator_name FROM items WHERE deleted_at IS NULL AND creator_name IS NOT NULL AND TRIM(creator_name) <> ''"),
  ]);
  const row = counts.results?.[0] ?? {};
  // 0件のとき SUM は NULL を返すので 0 にそろえる。
  const n = (key: string) => Number(row[key] ?? 0);
  return {
    total: n("total"), completed: n("completed"), movie: n("movie"), audio: n("audio"), text: n("text"),
    byStatus: { backlog: n("backlog"), in_progress: n("in_progress"), completed: n("completed"), dropped: n("dropped") },
    creators: (creators.results ?? []).map((r) => String(r.creator_name)).sort((a, b) => a.localeCompare(b, "ja")),
  };
}
