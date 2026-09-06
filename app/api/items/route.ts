import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { canonicalUrl } from "@/app/lib/text";
import { attachLinks, listItems } from "@/app/lib/queries/watch-list";
import { normalizeItem } from "@/app/lib/watch-list-item-input";
import { route } from "@/app/lib/route";

// Re-exported for app/api/items/[id]/route.ts and app/api/imports/route.ts,
// which both import this from here rather than from
// app/lib/watch-list-item-input.ts directly -- the actual pure logic lives
// there (see that file for why: it needs to run under vitest's plain-Node "node" project,
// which a module importing "cloudflare:workers" like this one cannot).
export { normalizeItem };
export type { ItemInput } from "@/app/lib/watch-list-item-input";

export const GET = route(async (request: Request) => {
  const { searchParams } = new URL(request.url);
  const result = await listItems({
    q: searchParams.get("q"),
    type: searchParams.get("type"),
    status: searchParams.get("status"),
    creator: searchParams.get("creator"),
    includeDeleted: searchParams.get("include_deleted") === "true",
    limit: Number(searchParams.get("limit")) || undefined,
    offset: Number(searchParams.get("offset")) || undefined,
  });
  return Response.json(result);
});

export const POST = route(async (request: Request) => {
  await ensureSchema();
  const normalized = normalizeItem(await request.json().catch(() => null));
  if (!normalized.value) return Response.json({ error: normalized.error }, { status: 400 });
  const item = normalized.value;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const statements = [env.DB.prepare(`INSERT INTO items (id, content_type, creator_name, series_title, title, description, priority, status, added_on, watched_on, comment, source_system, external_id, raw_source, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .bind(id, item.contentType, item.creatorName ?? "", item.seriesTitle ?? "", item.title, item.description ?? "", item.priority, item.status ?? "backlog", item.addedOn, item.watchedOn, item.comment ?? "", item.sourceSystem ?? "manual", item.externalId, item.rawSource, now, now)];
  for (const [position, link] of (item.links ?? []).entries()) {
    statements.push(env.DB.prepare("INSERT INTO item_links (id, item_id, label, url, link_type, position, canonical_url) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), id, link.label ?? "", link.url, link.linkType ?? "reference", position, canonicalUrl(link.url)));
  }
  await env.DB.batch(statements);
  const { results } = await env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).all<Record<string, unknown>>();
  return Response.json({ item: (await attachLinks(results ?? []))[0] }, { status: 201 });
});
