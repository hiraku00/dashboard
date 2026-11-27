import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { listChannels, listVideos } from "@/app/lib/queries/text-tube";
import { videosChannel, videosOffset, videosUnread } from "@/app/lib/text-tube-query";
import { videoInput } from "@/app/lib/text-tube-video-input";
import { route } from "@/app/lib/route";
import { youTubeVideoId } from "@/app/lib/youtube";

export const GET = route(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  const query = { q: params.get("q"), offset: params.get("offset"), unread: videosUnread(params.get("unread")), channel: videosChannel(params.get("channel")) };
  // チャンネルの選択肢は先頭ページのときだけ数える（続きのページでは変わらないので、数え直さない）。
  if (videosOffset(query.offset) > 0) return Response.json(await listVideos(query));
  const [list, channels] = await Promise.all([listVideos(query), listChannels(query)]);
  return Response.json({ ...list, channels });
});

export const POST = route(async (request: Request) => {
  await ensureSchema({ seed: false });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const parsed = videoInput(body ?? {});
  if (!parsed.value) return Response.json({ error: parsed.error }, { status: 400 });
  const value = parsed.value; const id = crypto.randomUUID(); const now = new Date().toISOString();
  // youtube_video_id は、Watch List のリンクから「もう TextTube にある動画か」を引く列(app/lib/text-tube-import.ts)。
  // 手で追加した動画にも入れておかないと、同じ動画を Watch List に入れたときに二重に取り込まれる。
  await env.DB.prepare(`INSERT INTO text_tube_videos (id,title,channel_name,thumbnail_url,original_url,summary,published_at,view_count,channel_thumbnail_url,duration,youtube_video_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,value.title,value.channelName,value.thumbnailUrl,value.originalUrl,value.summary,value.publishedAt,value.viewCount,value.channelThumbnailUrl,value.duration,youTubeVideoId(value.originalUrl) || null,now,now).run();
  return Response.json({ id }, { status: 201 });
});
