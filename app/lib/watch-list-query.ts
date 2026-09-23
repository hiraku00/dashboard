/** Pure decision logic for the Watch List's read path -- no D1, no I/O.
 *  Kept separate from app/lib/queries/watch-list.ts (which does the actual
 *  D1 calls) so it can run under vitest's plain-Node "node" project the same way
 *  manage-asset-core.ts, access.ts and the other app/lib/*.ts modules do;
 *  a module that imports "cloudflare:workers" at the top level cannot be
 *  loaded outside the Workers runtime at all, let alone unit tested. */
import { youTubeThumbnailFromLinks } from "./thumbnail.ts";
import { MAX_LIKE_TERM_BYTES, truncateUtf8Bytes } from "./sql-text.ts";
import { youTubeVideoId } from "./youtube.ts";

// clean() below duplicates app/lib/text.ts's on purpose -- keep it in sync.
// Cross-file imports do work here (thumbnail.ts above uses an explicit .ts
// extension, which tsconfig's allowImportingTsExtensions permits and plain
// Node's ESM resolver needs); this one-liner is just small enough that a
// second copy is cheaper than another import.
function clean(value: unknown, max = 4000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export type ContentType = "text" | "audio" | "movie" | "other";
export type WatchStatus = "backlog" | "in_progress" | "completed" | "dropped";

export const contentTypes = new Set<ContentType>(["text", "audio", "movie", "other"]);
export const statuses = new Set<WatchStatus>(["backlog", "in_progress", "completed", "dropped"]);

/** A link's TextTube auto-import status, attached only to links that are a
 *  YouTube video URL (see attachTextTubeStatus()). "none" covers both "not
 *  imported yet" and "imported, then deleted from TextTube" -- either way,
 *  the Watch List UI offers the same manual "TextTubeへ反映" action. */
export type TextTubeLinkStatus =
  | { status: "reflected"; videoId: string }
  | { status: "running" }
  | { status: "failed"; error: string }
  | { status: "none" };

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
  /** A YouTube link's derived thumbnail, else the stored og:image, else "". */
  thumbnailUrl: string;
  version: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  links: Array<{ id: unknown; label: unknown; url: unknown; linkType: unknown; position: unknown; textTube?: TextTubeLinkStatus }>;
};

/** Maps a raw D1 row (snake_case columns) plus its links into the camelCase
 *  shape the API and the page both render. */
export function toItem(row: Record<string, unknown>, links: Array<Record<string, unknown>>): WatchListItem {
  const storedThumbnail = typeof row.thumbnail_url === "string" ? row.thumbnail_url : "";
  return {
    id: row.id, contentType: row.content_type, creatorName: row.creator_name, seriesTitle: row.series_title,
    title: row.title, description: row.description, priority: row.priority, status: row.status,
    addedOn: row.added_on, watchedOn: row.watched_on, comment: row.comment, sourceSystem: row.source_system,
    externalId: row.external_id, thumbnailUrl: youTubeThumbnailFromLinks(links) || storedThumbnail, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    links: links.map((link) => ({ id: link.id, label: link.label, url: link.url, linkType: link.link_type, position: link.position })),
  };
}

/** The list's sort. `id` is the last key so two items with the same
 *  `added_on` and `created_at` (a bulk import stamps them alike) still have one
 *  fixed order: without it, LIMIT/OFFSET pages could repeat or skip such an
 *  item, and the list query and the links subquery in listItems() could
 *  disagree about which rows are on the page. */
export const ITEMS_ORDER_BY = "ORDER BY added_on IS NULL ASC, added_on DESC, created_at DESC, id ASC";

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
  // Truncated to a byte-safe length in addition to clean()'s 200-JS-char cap --
  // see sql-text.ts for why: a longer term inside `%${q}%` makes D1 reject the
  // whole query rather than just matching fewer rows.
  const q = truncateUtf8Bytes(clean(query.q, 200), MAX_LIKE_TERM_BYTES);
  const type = clean(query.type);
  const status = clean(query.status);
  const creator = clean(query.creator, 250);
  const includeDeleted = query.includeDeleted ?? false;
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);

  const clauses: string[] = [];
  const values: string[] = [];
  if (!includeDeleted) clauses.push("deleted_at IS NULL");
  // The links are matched with EXISTS rather than a JOIN, so an item with
  // several matching links is still one row (and one count). The subquery's
  // table is aliased because listItems() nests this whole WHERE inside a query
  // on item_links.
  if (q) {
    clauses.push("(title LIKE ? OR description LIKE ? OR creator_name LIKE ? OR series_title LIKE ? OR EXISTS (SELECT 1 FROM item_links l WHERE l.item_id = items.id AND (l.url LIKE ? OR l.label LIKE ?)))");
    values.push(...Array<string>(6).fill(`%${q}%`));
  }
  if (contentTypes.has(type as ContentType)) { clauses.push("content_type = ?"); values.push(type); }
  if (statuses.has(status as WatchStatus)) { clauses.push("status = ?"); values.push(status); }
  if (creator) { clauses.push("creator_name = ?"); values.push(creator); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return { where, values, limit, offset };
}

/** Decides one YouTube link's TextTube badge from the D1 rows
 *  app/lib/queries/watch-list.ts's attachTextTubeStatus() looked up for it
 *  -- pure so it's covered by this file's plain-Node tests instead of only
 *  by a D1-backed one.
 *
 *  `videoRow` wins outright: a live (non-deleted) text_tube_videos row
 *  means "reflected", full stop, even if an older import row also exists.
 *  Without one, the *latest* text_tube_imports row (by updated_at -- the
 *  caller already picked it) decides: running within `staleCutoffIso` is
 *  still in progress; running older than that is treated as stuck, i.e.
 *  the same "none" a caller can retry from as an import that never
 *  started; failed carries its error through; anything else (most notably
 *  a stale "done" whose video was later deleted from TextTube) also falls
 *  through to "none" -- deleted means not reflected, regardless of what a
 *  past attempt recorded. */
export function resolveTextTubeStatus(
  videoRow: { id: unknown } | undefined,
  importRow: { status: unknown; last_error?: unknown; updated_at: unknown } | undefined,
  staleCutoffIso: string,
): TextTubeLinkStatus {
  if (videoRow) return { status: "reflected", videoId: String(videoRow.id) };
  if (importRow?.status === "running" && String(importRow.updated_at) >= staleCutoffIso) return { status: "running" };
  if (importRow?.status === "failed") return { status: "failed", error: String(importRow.last_error ?? "") };
  return { status: "none" };
}

/** Attaches `textTube` to every link across `items` that is a YouTube video
 *  URL, given the D1 rows app/lib/queries/watch-list.ts's
 *  attachTextTubeStatus() looked up: the live text_tube_videos row (if
 *  any) and the latest text_tube_imports row, each keyed by YouTube video
 *  id. Links that are not a YouTube URL are returned unchanged (no
 *  `textTube` field at all, so the UI can tell "not applicable" from "not
 *  imported yet"). */
export function attachTextTubeStatus(
  items: WatchListItem[],
  videoRowsByYoutubeId: Map<string, { id: unknown }>,
  importRowsByYoutubeId: Map<string, { status: unknown; last_error?: unknown; updated_at: unknown }>,
  staleCutoffIso: string,
): WatchListItem[] {
  return items.map((item) => ({
    ...item,
    links: item.links.map((link) => {
      const videoId = youTubeVideoId(link.url);
      if (!videoId) return link;
      return {
        ...link,
        textTube: resolveTextTubeStatus(
          videoRowsByYoutubeId.get(videoId),
          importRowsByYoutubeId.get(videoId),
          staleCutoffIso,
        ),
      };
    }),
  }));
}
