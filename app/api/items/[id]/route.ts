import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { canonicalUrl } from "@/app/lib/text";
import { normalizeItem } from "../route";

async function itemResponse(id: string) {
  const itemResult = await env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).all<Record<string, unknown>>();
  const item = itemResult.results?.[0];
  if (!item) return null;
  const links = await env.DB.prepare("SELECT * FROM item_links WHERE item_id = ? ORDER BY position").bind(id).all<Record<string, unknown>>();
  return { id: item.id, contentType: item.content_type, creatorName: item.creator_name, seriesTitle: item.series_title, title: item.title, description: item.description, priority: item.priority, status: item.status, addedOn: item.added_on, watchedOn: item.watched_on, comment: item.comment, sourceSystem: item.source_system, externalId: item.external_id, version: item.version, createdAt: item.created_at, updatedAt: item.updated_at, links: (links.results ?? []).map((link) => ({ id: link.id, label: link.label, url: link.url, linkType: link.link_type, position: link.position })) };
}

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await params;
  const item = await itemResponse(id);
  return item ? Response.json({ item }) : Response.json({ error: "見つかりません。" }, { status: 404 });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const normalized = normalizeItem(body);
  if (!normalized.value) return Response.json({ error: normalized.error }, { status: 400 });
  const expectedVersion = Number((body as Record<string, unknown>)?.version);
  // A non-integer version can never match a real row's version (which is
  // always a positive integer), so this is rejected before touching D1 --
  // passing NaN as a bound parameter below would be meaningless anyway.
  if (!Number.isInteger(expectedVersion)) return Response.json({ error: "ほかの画面で更新されています。再読み込みしてください。" }, { status: 409 });
  const item = normalized.value;
  const now = new Date().toISOString();
  // The version check lives in this UPDATE's WHERE clause (AND version=?),
  // not in a separate SELECT-then-compare beforehand: a prior version of
  // this handler read the current row, compared versions in application
  // code, and only then ran an UPDATE whose WHERE clause did not itself
  // reference version -- leaving a window between the read and the write
  // where a concurrent request could pass the same check and both writes
  // land. Checking result.meta.changes here is the only point that can
  // actually tell whether this request's version was the one still current
  // at write time.
  const updateResult = await env.DB.prepare(`UPDATE items SET content_type=?, creator_name=?, series_title=?, title=?, description=?, priority=?, status=?, added_on=?, watched_on=?, comment=?, source_system=?, external_id=?, raw_source=?, version=version+1, updated_at=? WHERE id=? AND version=?`)
    .bind(item.contentType, item.creatorName ?? "", item.seriesTitle ?? "", item.title, item.description ?? "", item.priority, item.status ?? "backlog", item.addedOn, item.watchedOn, item.comment ?? "", item.sourceSystem ?? "manual", item.externalId, item.rawSource, now, id, expectedVersion).run();
  if (!updateResult.meta.changes) {
    // meta.changes === 0 means either the id doesn't exist, or it exists but
    // its version has already moved on -- distinguish them with one cheap
    // existence check rather than guessing.
    const exists = await env.DB.prepare("SELECT 1 FROM items WHERE id = ?").bind(id).first();
    return exists
      ? Response.json({ error: "ほかの画面で更新されています。再読み込みしてください。" }, { status: 409 })
      : Response.json({ error: "見つかりません。" }, { status: 404 });
  }
  // Only reached once the versioned UPDATE above actually matched a row --
  // otherwise this DELETE would silently wipe an existing item's links even
  // when the version check failed and nothing else about it was touched.
  const statements: D1PreparedStatement[] = [env.DB.prepare("DELETE FROM item_links WHERE item_id = ?").bind(id)];
  for (const [position, link] of (item.links ?? []).entries()) {
    // Same canonicalUrl() the POST path (app/api/items/route.ts) and
    // /api/imports use -- strips the fragment and utm_*/fbclid params, not
    // just the fragment. This handler used to compute its own canonical_url
    // inline with only the fragment stripped, so the same URL could get a
    // different canonical_url depending on whether it arrived via POST or
    // PATCH. normalizeItem() already validated every link.url through
    // canonicalUrl() above (see the `links.some((link) => !canonicalUrl(...))`
    // check in app/api/items/route.ts), so this cannot produce an empty string
    // here.
    statements.push(env.DB.prepare("INSERT INTO item_links (id, item_id, label, url, link_type, position, canonical_url) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), id, link.label ?? "", link.url, link.linkType ?? "reference", position, canonicalUrl(link.url)));
  }
  await env.DB.batch(statements);
  return Response.json({ item: await itemResponse(id) });
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await params;
  const result = await env.DB.prepare("UPDATE items SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL").bind(new Date().toISOString(), new Date().toISOString(), id).run();
  return result.meta.changes ? Response.json({ ok: true }) : Response.json({ error: "見つかりません。" }, { status: 404 });
}
