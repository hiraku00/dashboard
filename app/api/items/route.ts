import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";

type ContentType = "text" | "audio" | "movie" | "other";
type Status = "backlog" | "in_progress" | "completed" | "dropped";

const contentTypes = new Set<ContentType>(["text", "audio", "movie", "other"]);
const statuses = new Set<Status>(["backlog", "in_progress", "completed", "dropped"]);

export type ItemInput = {
  contentType: ContentType;
  creatorName?: string;
  seriesTitle?: string;
  title: string;
  description?: string;
  priority?: number | null;
  status?: Status;
  addedOn?: string | null;
  watchedOn?: string | null;
  comment?: string;
  sourceSystem?: string;
  externalId?: string | null;
  rawSource?: string | null;
  links?: Array<{ label?: string; url: string; linkType?: string }>;
};

function cleanText(value: unknown, max = 4000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validDate(value: string) {
  return !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function canonicalUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || key === "fbclid") url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

export function normalizeItem(input: unknown): { value?: ItemInput; error?: string } {
  if (!input || typeof input !== "object") return { error: "JSONオブジェクトを指定してください。" };
  const source = input as Record<string, unknown>;
  const contentType = cleanText(source.contentType) as ContentType;
  const status = (cleanText(source.status) || "backlog") as Status;
  const title = cleanText(source.title, 1000);
  const addedOn = cleanText(source.addedOn, 10);
  const watchedOn = cleanText(source.watchedOn, 10);
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
  if (links.some((link) => !canonicalUrl(link.url))) return { error: "リンクには http または https のURLを指定してください。" };

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

function toItem(row: Record<string, unknown>, links: Array<Record<string, unknown>>) {
  return {
    id: row.id, contentType: row.content_type, creatorName: row.creator_name, seriesTitle: row.series_title,
    title: row.title, description: row.description, priority: row.priority, status: row.status,
    addedOn: row.added_on, watchedOn: row.watched_on, comment: row.comment, sourceSystem: row.source_system,
    externalId: row.external_id, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    links: links.map((link) => ({ id: link.id, label: link.label, url: link.url, linkType: link.link_type, position: link.position })),
  };
}

async function attachLinks(rows: Array<Record<string, unknown>>) {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id as string);
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(`SELECT * FROM item_links WHERE item_id IN (${placeholders}) ORDER BY position ASC`).bind(...ids).all<Record<string, unknown>>();
  const byItem = new Map<string, Array<Record<string, unknown>>>();
  for (const link of results ?? []) {
    const itemId = String(link.item_id);
    byItem.set(itemId, [...(byItem.get(itemId) ?? []), link]);
  }
  return rows.map((row) => toItem(row, byItem.get(String(row.id)) ?? []));
}

export async function GET(request: Request) {
  await ensureSchema();
  const { searchParams } = new URL(request.url);
  const query = cleanText(searchParams.get("q"), 200);
  const type = cleanText(searchParams.get("type"));
  const status = cleanText(searchParams.get("status"));
  const creator = cleanText(searchParams.get("creator"), 250);
  const includeDeleted = searchParams.get("include_deleted") === "true";
  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 50, 1), 100);
  const offset = Math.max(Number(searchParams.get("offset")) || 0, 0);
  const clauses: string[] = [];
  const values: string[] = [];
  if (!includeDeleted) clauses.push("deleted_at IS NULL");
  if (query) { clauses.push("(title LIKE ? OR description LIKE ? OR creator_name LIKE ? OR series_title LIKE ?)"); values.push(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`); }
  if (contentTypes.has(type as ContentType)) { clauses.push("content_type = ?"); values.push(type); }
  if (statuses.has(status as Status)) { clauses.push("status = ?"); values.push(status); }
  if (creator) { clauses.push("creator_name = ?"); values.push(creator); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const [rows, totalResult] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM items ${where} ORDER BY added_on IS NULL ASC, added_on DESC, created_at DESC LIMIT ? OFFSET ?`).bind(...values, limit, offset),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM items ${where}`).bind(...values),
  ]);
  const results = rows.results as Array<Record<string, unknown>> | undefined;
  const items = await attachLinks(results ?? []);
  const total = Number((totalResult.results?.[0] as { count?: number } | undefined)?.count ?? 0);
  return Response.json({ items, pagination: { total, limit, offset, hasMore: offset + items.length < total } });
}

export async function POST(request: Request) {
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
}
