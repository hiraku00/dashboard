/** Pure decision logic for the Watch List's read path -- no D1, no I/O.
 *  Kept separate from app/lib/queries/watch-list.ts (which does the actual
 *  D1 calls) so it can run under vitest's plain-Node "node" project the same way
 *  manage-asset-core.ts, access.ts and the other app/lib/*.ts modules do;
 *  a module that imports "cloudflare:workers" at the top level cannot be
 *  loaded outside the Workers runtime at all, let alone unit tested. */
// Deliberately not importing app/lib/text.ts's clean() here, even though the
// logic is identical: a cross-file import (relative or "@/...") cannot be
// resolved by plain Node without an explicit extension that in turn breaks
// tsc (`allowImportingTsExtensions` is off), and this module has to load
// under vitest's plain-Node "node" project. Every other pure app/lib/*.ts module (e.g.
// manage-asset-core.ts, access.ts) has zero imports for the same reason.
// This one-liner is small enough that duplicating it is safer than fighting
// module resolution -- keep it in sync with clean() in app/lib/text.ts.
function clean(value: unknown, max = 4000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export type ContentType = "text" | "audio" | "movie" | "other";
export type WatchStatus = "backlog" | "in_progress" | "completed" | "dropped";

export const contentTypes = new Set<ContentType>(["text", "audio", "movie", "other"]);
export const statuses = new Set<WatchStatus>(["backlog", "in_progress", "completed", "dropped"]);

export type WatchListItem = {
  id: unknown;
  contentType: unknown;
  creatorName: unknown;
  seriesTitle: unknown;
  title: unknown;
  description: unknown;
  priority: unknown;
  status: unknown;
  addedOn: unknown;
  watchedOn: unknown;
  comment: unknown;
  sourceSystem: unknown;
  externalId: unknown;
  version: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  links: Array<{ id: unknown; label: unknown; url: unknown; linkType: unknown; position: unknown }>;
};

/** Maps a raw D1 row (snake_case columns) plus its links into the camelCase
 *  shape the API and the page both render. */
export function toItem(row: Record<string, unknown>, links: Array<Record<string, unknown>>): WatchListItem {
  return {
    id: row.id, contentType: row.content_type, creatorName: row.creator_name, seriesTitle: row.series_title,
    title: row.title, description: row.description, priority: row.priority, status: row.status,
    addedOn: row.added_on, watchedOn: row.watched_on, comment: row.comment, sourceSystem: row.source_system,
    externalId: row.external_id, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    links: links.map((link) => ({ id: link.id, label: link.label, url: link.url, linkType: link.link_type, position: link.position })),
  };
}

export type ListItemsQuery = {
  q?: string | null;
  type?: string | null;
  status?: string | null;
  creator?: string | null;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
};

export type ItemsFilter = { where: string; values: string[]; limit: number; offset: number };

/** The pure "what SQL should this request produce" decision: sanitizing and
 *  clamping the raw query params, with no I/O. app/api/items/route.ts (GET)
 *  and the Watch List page's Server Component both go through this via
 *  listItems() in app/lib/queries/watch-list.ts, so a bug here would
 *  silently make the two disagree on what "the list" contains. */
export function buildItemsFilter(query: ListItemsQuery = {}): ItemsFilter {
  // clean() is the same helper app/api/items/route.ts used to sanitize these
  // before this function existed -- keep it here rather than trusting the
  // caller so a page.tsx that forgets to sanitize can't diverge from the API.
  const q = clean(query.q, 200);
  const type = clean(query.type);
  const status = clean(query.status);
  const creator = clean(query.creator, 250);
  const includeDeleted = query.includeDeleted ?? false;
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);

  const clauses: string[] = [];
  const values: string[] = [];
  if (!includeDeleted) clauses.push("deleted_at IS NULL");
  if (q) { clauses.push("(title LIKE ? OR description LIKE ? OR creator_name LIKE ? OR series_title LIKE ?)"); values.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  if (contentTypes.has(type as ContentType)) { clauses.push("content_type = ?"); values.push(type); }
  if (statuses.has(status as WatchStatus)) { clauses.push("status = ?"); values.push(status); }
  if (creator) { clauses.push("creator_name = ?"); values.push(creator); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return { where, values, limit, offset };
}
