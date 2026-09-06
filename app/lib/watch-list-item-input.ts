/** Pure validation/normalization for a Watch List item's write path -- no
 *  D1, no I/O. Kept separate from app/api/items/route.ts (which does the
 *  actual D1 writes and re-exports this for app/api/items/[id]/route.ts and
 *  app/api/imports/route.ts) for the same reason as app/lib/watch-list-query.ts:
 *  a module that imports "cloudflare:workers" at the top level cannot be
 *  loaded outside the Workers runtime at all, let alone unit tested under
 *  plain `node --test`.
 *
 *  Imports app/lib/text.ts by relative path with an explicit .ts extension
 *  (rather than the "@/..." alias, which plain Node's ESM resolver cannot
 *  follow) so this stays loadable under `node --test` -- see
 *  allowImportingTsExtensions in tsconfig.json for why tsc also accepts
 *  this. */
import { canonicalUrl, clean as cleanText, validDate } from "./text.ts";

export type ContentType = "text" | "audio" | "movie" | "other";
export type WatchStatus = "backlog" | "in_progress" | "completed" | "dropped";

export const contentTypes = new Set<ContentType>(["text", "audio", "movie", "other"]);
export const statuses = new Set<WatchStatus>(["backlog", "in_progress", "completed", "dropped"]);

export type ItemInput = {
  contentType: ContentType;
  creatorName?: string;
  seriesTitle?: string;
  title: string;
  description?: string;
  priority?: number | null;
  status?: WatchStatus;
  addedOn?: string | null;
  watchedOn?: string | null;
  comment?: string;
  sourceSystem?: string;
  externalId?: string | null;
  rawSource?: string | null;
  links?: Array<{ label?: string; url: string; linkType?: string }>;
};

/** app/api/items/route.ts (POST) and app/api/items/[id]/route.ts (PATCH)
 *  both go through this via the re-export in app/api/items/route.ts, so a
 *  bug here would silently make new items and edited items validate
 *  differently. */
export function normalizeItem(input: unknown): { value?: ItemInput; error?: string } {
  if (!input || typeof input !== "object") return { error: "JSONオブジェクトを指定してください。" };
  const source = input as Record<string, unknown>;
  const contentType = cleanText(source.contentType) as ContentType;
  const status = (cleanText(source.status) || "backlog") as WatchStatus;
  const title = cleanText(source.title, 1000);
  const addedOn = cleanText(source.addedOn, 10);
  const watchedOn = status === "completed" ? cleanText(source.watchedOn, 10) : "";
  const priority = source.priority === null || source.priority === undefined || source.priority === "" ? null : Number(source.priority);

  if (!contentTypes.has(contentType)) return { error: "種別は text / audio / movie / other のいずれかです。" };
  if (!statuses.has(status)) return { error: "ステータスが不正です。" };
  if (!title) return { error: "タイトルは必須です。" };
  if (!validDate(addedOn) || !validDate(watchedOn)) return { error: "日付は YYYY-MM-DD 形式で指定してください。" };
  if (priority !== null && (!Number.isInteger(priority) || priority < 1 || priority > 5)) return { error: "優先度は1〜5で指定してください。" };

  const links = Array.isArray(source.links)
    ? source.links.map((link) => {
        const data = link && typeof link === "object" ? (link as Record<string, unknown>) : {};
        return { label: cleanText(data.label, 120), url: cleanText(data.url, 2000), linkType: cleanText(data.linkType, 60) || "reference" };
      }).filter((link) => link.url)
    : [];
  // Rejects a link canonicalUrl() cannot parse into http/https, and also
  // two links on the SAME item that canonicalize to the same destination
  // (e.g. the same URL with and without a utm_ param). The second check
  // matches item_links_canonical_idx's scope: that index is UNIQUE on
  // (item_id, canonical_url), not on canonical_url alone -- production data
  // has many *different* items legitimately sharing one canonical_url (a
  // shared series-archive page linked from every episode's item), so a
  // global unique index would have been wrong. See Issue #76.
  const seenCanonicalUrls = new Set<string>();
  for (const link of links) {
    const canonical = canonicalUrl(link.url);
    if (!canonical) return { error: "リンクには http または https のURLを指定してください。" };
    if (seenCanonicalUrls.has(canonical)) return { error: "同じリンクが重複しています。" };
    seenCanonicalUrls.add(canonical);
  }

  return {
    value: {
      contentType,
      creatorName: cleanText(source.creatorName, 250),
      seriesTitle: cleanText(source.seriesTitle, 500),
      title,
      description: cleanText(source.description, 12000),
      priority,
      status,
      addedOn: addedOn || null,
      watchedOn: watchedOn || null,
      comment: cleanText(source.comment, 12000),
      sourceSystem: cleanText(source.sourceSystem, 100) || "manual",
      externalId: cleanText(source.externalId, 500) || null,
      rawSource: typeof source.rawSource === "string" ? source.rawSource.slice(0, 30000) : null,
      links,
    },
  };
}
