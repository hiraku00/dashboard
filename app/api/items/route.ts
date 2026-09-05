import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { canonicalUrl, clean as cleanText, validDate } from "@/app/lib/text";
import { attachLinks, listItems } from "@/app/lib/queries/watch-list";

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

export function normalizeItem(input: unknown): { value?: ItemInput; error?: string } {
  if (!input || typeof input !== "object") return { error: "JSONオブジェクトを指定してください。" };
  const source = input as Record<string, unknown>;
  const contentType = cleanText(source.contentType) as ContentType;
  const status = (cleanText(source.status) || "backlog") as Status;
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

export async function GET(request: Request) {
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
