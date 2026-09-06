import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { canonicalUrl } from "@/app/lib/text";
import { attachLinks } from "@/app/lib/queries/watch-list";
import { normalizeItem } from "../route";
import { route } from "@/app/lib/route";

// Delegates the row->API-shape mapping to attachLinks()/toItem() in
// app/lib/queries/watch-list.ts -- the same functions listItems() (used by
// GET /api/items and the Watch List page's Server Component) goes through.
// This used to have its own inline mapping and its own separate
// `SELECT * FROM item_links` query, duplicating toItem()'s field-by-field
// camelCase mapping exactly; a future change to that mapping would have
// silently stopped applying to a single item's GET/PATCH response while
// still applying everywhere else.
async function itemResponse(id: string) {
  const itemResult = await env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).all<Record<string, unknown>>();
  const row = itemResult.results?.[0];
  if (!row) return null;
  return (await attachLinks([row]))[0];
}

export const GET = route(async (_: Request, { params }: { params: Promise<{ id: string }> }) => {
  await ensureSchema();
  const { id } = await params;
  const item = await itemResponse(id);
  return item ? Response.json({ item }) : Response.json({ error: "見つかりません。" }, { status: 404 });
});

export const PATCH = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
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
});

export const DELETE = route(async (_: Request, { params }: { params: Promise<{ id: string }> }) => {
  await ensureSchema();
  const { id } = await params;
  const result = await env.DB.prepare("UPDATE items SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL").bind(new Date().toISOString(), new Date().toISOString(), id).run();
  return result.meta.changes ? Response.json({ ok: true }) : Response.json({ error: "見つかりません。" }, { status: 404 });
});
