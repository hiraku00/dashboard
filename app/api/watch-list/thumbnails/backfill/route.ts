import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { route } from "@/app/lib/route";
import { resolveStoredThumbnail } from "@/app/lib/thumbnail-fetch";

/** Items looked up per call. Each one can make up to two page fetches, and a
 *  Worker invocation has a small subrequest and CPU budget, so the client
 *  walks the list in a loop (following `next`) instead of one big request. */
const BATCH_SIZE = 4;

/** Fills items.thumbnail_url for items saved before thumbnails existed, or
 *  whose page had no preview image when they were saved.
 *
 *  Pages through items by id: pass the previous response's `next` as `after`
 *  until it is null. Progress is by cursor rather than by "still empty" so an
 *  item whose page has no image is visited once per run, not forever; running
 *  it again later retries those. Items with a YouTube link are skipped by
 *  resolveStoredThumbnail() -- their thumbnail is derived on read. */
export const POST = route(async (request: Request) => {
  await ensureSchema();
  const body = await request.json().catch(() => null) as { after?: unknown } | null;
  const after = typeof body?.after === "string" ? body.after : "";

  const { results: items } = await env.DB.prepare("SELECT id FROM items WHERE deleted_at IS NULL AND thumbnail_url = '' AND id > ? ORDER BY id ASC LIMIT ?")
    .bind(after, BATCH_SIZE).all<{ id: string }>();
  const ids = (items ?? []).map((row) => row.id);
  if (!ids.length) return Response.json({ processed: 0, found: 0, next: null });

  const { results: links } = await env.DB.prepare(`SELECT item_id, url FROM item_links WHERE item_id IN (${ids.map(() => "?").join(",")}) ORDER BY position ASC`)
    .bind(...ids).all<{ item_id: string; url: string }>();
  const urlsByItem = new Map<string, string[]>();
  for (const link of links ?? []) urlsByItem.set(link.item_id, [...(urlsByItem.get(link.item_id) ?? []), link.url]);

  const thumbnails = await Promise.all(ids.map((id) => resolveStoredThumbnail(urlsByItem.get(id) ?? [])));
  const updates = ids.flatMap((id, index) => thumbnails[index]
    // AND thumbnail_url = '' keeps a concurrent save's newer value.
    ? [env.DB.prepare("UPDATE items SET thumbnail_url = ? WHERE id = ? AND thumbnail_url = ''").bind(thumbnails[index], id)]
    : []);
  if (updates.length) await env.DB.batch(updates);

  return Response.json({ processed: ids.length, found: updates.length, next: ids.length === BATCH_SIZE ? ids[ids.length - 1] : null });
});
