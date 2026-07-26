import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { normalizeItem } from "../items/route";

export async function POST(request: Request) {
  await ensureSchema();
  const body = await request.json().catch(() => null) as { sourceName?: unknown; items?: unknown } | null;
  if (!body || !Array.isArray(body.items)) return Response.json({ error: "items配列を含むJSONを指定してください。" }, { status: 400 });
  if (body.items.length > 200) return Response.json({ error: "一度に取り込めるのは200件までです。" }, { status: 400 });
  const runId = crypto.randomUUID(); const sourceName = typeof body.sourceName === "string" ? body.sourceName.slice(0, 100) : "api-import";
  let created = 0; let errors = 0; const messages: Array<{ index: number; error: string }> = [];
  for (const [index, candidate] of body.items.entries()) {
    const normalized = normalizeItem(candidate);
    if (!normalized.value) { errors++; messages.push({ index, error: normalized.error ?? "不正なデータです。" }); continue; }
    const item = normalized.value; const source = item.sourceSystem || sourceName; const now = new Date().toISOString();
    const existing = item.externalId ? (await env.DB.prepare("SELECT id FROM items WHERE source_system=? AND external_id=?").bind(source, item.externalId).all<Record<string, unknown>>()).results?.[0] : null;
    if (existing) { messages.push({ index, error: "同じ外部IDのためスキップしました。" }); continue; }
    const id = crypto.randomUUID(); const statements = [env.DB.prepare("INSERT INTO items (id,content_type,creator_name,series_title,title,description,priority,status,added_on,watched_on,comment,source_system,external_id,raw_source,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)").bind(id,item.contentType,item.creatorName ?? "",item.seriesTitle ?? "",item.title,item.description ?? "",item.priority,item.status ?? "backlog",item.addedOn,item.watchedOn,item.comment ?? "",source,item.externalId,item.rawSource,now,now)];
    for (const [position, link] of (item.links ?? []).entries()) { const url = new URL(link.url); url.hash = ""; statements.push(env.DB.prepare("INSERT INTO item_links (id,item_id,label,url,link_type,position,canonical_url) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(),id,link.label ?? "",link.url,link.linkType ?? "reference",position,url.toString())); }
    await env.DB.batch(statements); created++;
  }
  await env.DB.prepare("INSERT INTO import_runs (id,source_name,total_count,created_count,updated_count,error_count) VALUES (?,?,?,?,?,?)").bind(runId,sourceName,body.items.length,created,0,errors).run();
  return Response.json({ runId, total: body.items.length, created, errors, messages }, { status: errors ? 207 : 201 });
}
