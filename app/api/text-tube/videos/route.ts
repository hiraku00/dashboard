import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { clean } from "@/app/lib/portal";
import { listVideos } from "@/app/lib/queries/text-tube";

function videoInput(body: Record<string, unknown>) {
  const title = clean(body.title, 1000);
  if (!title) return { error: "タイトルは必須です。" };
  return { value: { title, channelName: clean(body.channelName, 500), thumbnailUrl: clean(body.thumbnailUrl, 2000), originalUrl: clean(body.originalUrl, 2000), summary: clean(body.summary, 30000), publishedAt: clean(body.publishedAt, 40) || null, viewCount: Math.max(0, Number(body.viewCount) || 0), channelThumbnailUrl: clean(body.channelThumbnailUrl, 2000), duration: clean(body.duration, 100) } };
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q");
  return Response.json(await listVideos({ q }));
}

export async function POST(request: Request) {
  await ensureSchema({ seed: false });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const parsed = videoInput(body ?? {});
  if (!parsed.value) return Response.json({ error: parsed.error }, { status: 400 });
  const value = parsed.value; const id = crypto.randomUUID(); const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO text_tube_videos (id,title,channel_name,thumbnail_url,original_url,summary,published_at,view_count,channel_thumbnail_url,duration,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,value.title,value.channelName,value.thumbnailUrl,value.originalUrl,value.summary,value.publishedAt,value.viewCount,value.channelThumbnailUrl,value.duration,now,now).run();
  return Response.json({ id }, { status: 201 });
}
