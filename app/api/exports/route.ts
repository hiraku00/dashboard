import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { route } from "@/app/lib/route";

export const GET = route(async (request: Request) => {
  await ensureSchema();
  const format = new URL(request.url).searchParams.get("format") ?? "json";
  const items = (await env.DB.prepare("SELECT * FROM items WHERE deleted_at IS NULL ORDER BY COALESCE(added_on, created_at) DESC").all<Record<string, unknown>>()).results ?? [];
  const links = (await env.DB.prepare("SELECT * FROM item_links ORDER BY position").all<Record<string, unknown>>()).results ?? [];
  const byItem = new Map<string, Array<Record<string, unknown>>>();
  for (const link of links) byItem.set(String(link.item_id), [...(byItem.get(String(link.item_id)) ?? []), link]);
  const payload: Array<Record<string, unknown>> = items.map((item) => ({ ...item, links: byItem.get(String(item.id)) ?? [] }));
  if (format === "csv") {
    const header = ["type", "creator", "series", "title", "description", "priority", "status", "added_on", "watched_on", "links", "comment"];
    const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const body = payload.map((item) => [item.content_type, item.creator_name, item.series_title, item.title, item.description, item.priority, item.status, item.added_on, item.watched_on, (item.links as Array<Record<string, unknown>>).map((link) => link.url).join("\n"), item.comment].map(escape).join(","));
    return new Response([header.join(","), ...body].join("\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=watch-list.csv" } });
  }
  return Response.json({ exportedAt: new Date().toISOString(), items: payload }, { headers: { "content-disposition": "attachment; filename=watch-list.json" } });
});
