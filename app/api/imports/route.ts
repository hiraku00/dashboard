import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { normalizeItem, type ItemInput } from "../items/route";
import { canonicalUrl } from "@/app/lib/text";
import { route } from "@/app/lib/route";

/** D1 rejects very large statement batches, and the rest of this codebase
 *  chunks at the same size (see db/index.ts and the Manage Asset history
 *  import). */
const BATCH_SIZE = 50;

/** Each pair binds two variables and SQLite allows 100 per statement, so stay
 *  well inside that. */
const LOOKUP_PAIRS_PER_QUERY = 40;

/** Key for the "already imported" set. Both halves are free-form text, so a
 *  plain separator could be produced by two different pairs; JSON quoting
 *  cannot. The two sides of this comparison previously built their keys
 *  differently, which stopped the check from matching existing rows at all. */
const importKey = (source: string, externalId: string) => JSON.stringify([source, externalId]);

type Prepared = { index: number; item: ItemInput; source: string };

export const POST = route(async (request: Request) => {
  await ensureSchema();
  const body = await request.json().catch(() => null) as { sourceName?: unknown; items?: unknown } | null;
  if (!body || !Array.isArray(body.items)) return Response.json({ error: "items配列を含むJSONを指定してください。" }, { status: 400 });
  if (body.items.length > 200) return Response.json({ error: "一度に取り込めるのは200件までです。" }, { status: 400 });
  const runId = crypto.randomUUID(); const sourceName = typeof body.sourceName === "string" ? body.sourceName.slice(0, 100) : "api-import";
  const messages: Array<{ index: number; error: string }> = [];
  let errors = 0;

  const accepted: Prepared[] = [];
  for (const [index, candidate] of body.items.entries()) {
    const normalized = normalizeItem(candidate);
    if (!normalized.value) { errors++; messages.push({ index, error: normalized.error ?? "不正なデータです。" }); continue; }
    accepted.push({ index, item: normalized.value, source: normalized.value.sourceSystem || sourceName });
  }

  // Look the external ids up in a handful of indexed queries instead of one
  // SELECT per item. With the 200-item cap this replaced up to 200 round
  // trips, and the pairs go through the items_source_external_idx unique
  // index. Chunked because each pair costs two bind variables and SQLite caps
  // a statement at 100 of them -- an unchunked 100-item import failed with
  // "too many SQL variables".
  const keyed = accepted.filter((entry) => entry.item.externalId);
  const known = new Set<string>();
  for (let start = 0; start < keyed.length; start += LOOKUP_PAIRS_PER_QUERY) {
    const slice = keyed.slice(start, start + LOOKUP_PAIRS_PER_QUERY);
    const placeholders = slice.map(() => "(?,?)").join(",");
    const bindings = slice.flatMap((entry) => [entry.source, entry.item.externalId as string]);
    const { results } = await env.DB
      .prepare(`SELECT source_system, external_id FROM items WHERE (source_system, external_id) IN (VALUES ${placeholders})`)
      .bind(...bindings)
      .all<{ source_system: string; external_id: string }>();
    for (const row of results ?? []) known.add(importKey(row.source_system, row.external_id));
  }

  const statements: D1PreparedStatement[] = [];
  const inserted: number[] = [];
  for (const entry of accepted) {
    const externalKey = entry.item.externalId ? importKey(entry.source, entry.item.externalId) : null;
    // `known` covers rows already in the table and ones an earlier item in
    // this same request has just claimed; without the second case a payload
    // carrying the same external id twice would fail the whole insert batch
    // on the unique index rather than skipping the duplicate.
    if (externalKey && known.has(externalKey)) { messages.push({ index: entry.index, error: "同じ外部IDのためスキップしました。" }); continue; }
    if (externalKey) known.add(externalKey);
    const item = entry.item; const id = crypto.randomUUID(); const now = new Date().toISOString();
    statements.push(env.DB.prepare("INSERT INTO items (id,content_type,creator_name,series_title,title,description,priority,status,added_on,watched_on,comment,source_system,external_id,raw_source,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)").bind(id,item.contentType,item.creatorName ?? "",item.seriesTitle ?? "",item.title,item.description ?? "",item.priority,item.status ?? "backlog",item.addedOn,item.watchedOn,item.comment ?? "",entry.source,item.externalId,item.rawSource,now,now));
    // Same canonicalUrl() the /api/items POST path uses (strips the fragment
    // and utm_*/fbclid params), so an imported link and one entered manually
    // dedupe against item_links_canonical_idx the same way -- that index is
    // UNIQUE per (item_id, canonical_url), not global (see Issue #76), so
    // this only matters for links landing on the same item.
    for (const [position, link] of (item.links ?? []).entries()) { statements.push(env.DB.prepare("INSERT INTO item_links (id,item_id,label,url,link_type,position,canonical_url) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(),id,link.label ?? "",link.url,link.linkType ?? "reference",position,canonicalUrl(link.url))); }
    inserted.push(entry.index);
  }

  // One item's rows must not be split across two batches, or a failing chunk
  // could leave an item without its links, so close the chunk before an item
  // whose statements would overflow it.
  let created = 0;
  const chunks: Array<{ statements: D1PreparedStatement[]; indexes: number[] }> = [];
  {
    let current: { statements: D1PreparedStatement[]; indexes: number[] } = { statements: [], indexes: [] };
    let cursor = 0;
    for (const index of inserted) {
      const item = accepted.find((entry) => entry.index === index)!.item;
      const size = 1 + (item.links?.length ?? 0);
      if (current.statements.length && current.statements.length + size > BATCH_SIZE) { chunks.push(current); current = { statements: [], indexes: [] }; }
      current.statements.push(...statements.slice(cursor, cursor + size));
      current.indexes.push(index);
      cursor += size;
    }
    if (current.statements.length) chunks.push(current);
  }
  for (const chunk of chunks) {
    try {
      await env.DB.batch(chunk.statements);
      created += chunk.indexes.length;
    } catch (error) {
      // Report the whole chunk rather than claiming a success we did not get.
      errors += chunk.indexes.length;
      const reason = error instanceof Error ? error.message : "保存に失敗しました。";
      for (const index of chunk.indexes) messages.push({ index, error: reason });
    }
  }

  await env.DB.prepare("INSERT INTO import_runs (id,source_name,total_count,created_count,updated_count,error_count) VALUES (?,?,?,?,?,?)").bind(runId,sourceName,body.items.length,created,0,errors).run();
  return Response.json({ runId, total: body.items.length, created, errors, messages }, { status: errors ? 207 : 201 });
});
