import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { listVideos } from "@/app/lib/queries/text-tube";
import { videoInput } from "@/app/lib/text-tube-video-input";
import { route } from "@/app/lib/route";

export const GET = route(async (request: Request) => {
  const q = new URL(request.url).searchParams.get("q");
  return Response.json(await listVideos({ q }));
});

export const POST = route(async (request: Request) => {
  await ensureSchema({ seed: false });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const parsed = videoInput(body ?? {});
  if (!parsed.value) return Response.json({ error: parsed.error }, { status: 400 });
  const value = parsed.value; const id = crypto.randomUUID(); const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO text_tube_videos (id,title,channel_name,thumbnail_url,original_url,summary,published_at,view_count,channel_thumbnail_url,duration,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,value.title,value.channelName,value.thumbnailUrl,value.originalUrl,value.summary,value.publishedAt,value.viewCount,value.channelThumbnailUrl,value.duration,now,now).run();
  return Response.json({ id }, { status: 201 });
});
