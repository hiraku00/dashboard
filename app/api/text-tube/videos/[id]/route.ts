import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { clean } from "@/app/lib/portal";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  await ensureSchema({ seed: false }); const { id } = await context.params;
  const result = await env.DB.prepare("SELECT * FROM text_tube_videos WHERE id=? AND deleted_at IS NULL").bind(id).all<Record<string, unknown>>();
  const video = result.results?.[0]; if (!video) return Response.json({ error: "動画が見つかりません。" }, { status: 404 });
  return Response.json({ video });
}

export async function PATCH(request: Request, context: Context) {
  await ensureSchema({ seed: false }); const { id } = await context.params; const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const title = clean(body?.title, 1000); if (!title) return Response.json({ error: "タイトルは必須です。" }, { status: 400 });
  const now = new Date().toISOString();
  const result = await env.DB.prepare("UPDATE text_tube_videos SET title=?,channel_name=?,thumbnail_url=?,original_url=?,summary=?,published_at=?,view_count=?,channel_thumbnail_url=?,duration=?,updated_at=? WHERE id=? AND deleted_at IS NULL").bind(title,clean(body?.channelName,500),clean(body?.thumbnailUrl,2000),clean(body?.originalUrl,2000),clean(body?.summary,30000),clean(body?.publishedAt,40)||null,Math.max(0,Number(body?.viewCount)||0),clean(body?.channelThumbnailUrl,2000),clean(body?.duration,100),now,id).run();
  if (!result.success) return Response.json({ error: "動画を更新できませんでした。" }, { status: 500 });
  return Response.json({ ok: true });
}

export async function DELETE(_request: Request, context: Context) {
  await ensureSchema({ seed: false }); const { id } = await context.params;
  await env.DB.prepare("UPDATE text_tube_videos SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL").bind(new Date().toISOString(),new Date().toISOString(),id).run();
  return Response.json({ ok: true });
}
