import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { videoInput } from "@/app/lib/text-tube-video-input";
import { getVideo } from "@/app/lib/queries/text-tube";
import { route } from "@/app/lib/route";

type Context = { params: Promise<{ id: string }> };

export const GET = route(async (_request: Request, context: Context) => {
  const { id } = await context.params;
  const video = await getVideo(id);
  if (!video) return Response.json({ error: "動画が見つかりません。" }, { status: 404 });
  return Response.json({ video });
});

export const PATCH = route(async (request: Request, context: Context) => {
  await ensureSchema({ seed: false }); const { id } = await context.params; const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const parsed = videoInput(body ?? {});
  if (!parsed.value) return Response.json({ error: parsed.error }, { status: 400 });
  const value = parsed.value; const now = new Date().toISOString();
  const result = await env.DB.prepare("UPDATE text_tube_videos SET title=?,channel_name=?,thumbnail_url=?,original_url=?,summary=?,published_at=?,view_count=?,channel_thumbnail_url=?,duration=?,updated_at=? WHERE id=? AND deleted_at IS NULL").bind(value.title,value.channelName,value.thumbnailUrl,value.originalUrl,value.summary,value.publishedAt,value.viewCount,value.channelThumbnailUrl,value.duration,now,id).run();
  if (!result.success) return Response.json({ error: "動画を更新できませんでした。" }, { status: 500 });
  return Response.json({ ok: true });
});

export const DELETE = route(async (_request: Request, context: Context) => {
  await ensureSchema({ seed: false }); const { id } = await context.params;
  await env.DB.prepare("UPDATE text_tube_videos SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL").bind(new Date().toISOString(),new Date().toISOString(),id).run();
  return Response.json({ ok: true });
});
