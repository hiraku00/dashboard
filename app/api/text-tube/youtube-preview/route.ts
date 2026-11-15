import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { youTubeVideoId } from "@/app/lib/youtube";
import { route } from "@/app/lib/route";
import {
  detailedScriptMarkdown,
  fetchYouTubeVideoInfo,
  fetchYouTubeTranscript,
} from "@/app/lib/youtube-video-fetch";

export const POST = route(async (request: Request) => {
  await ensureSchema({ seed: false });
  const id = youTubeVideoId(
    ((await request.json().catch(() => ({}))) as { url?: unknown }).url,
  );
  const key = (env as { YOUTUBE_DATA_API_KEY?: string }).YOUTUBE_DATA_API_KEY;
  const supadataKey = (env as { SUPADATA_API_KEY?: string }).SUPADATA_API_KEY;
  if (!id)
    return Response.json(
      { error: "YouTube動画のURLを入力してください。" },
      { status: 400 },
    );
  if (!key)
    return Response.json(
      { error: "YouTube連携が設定されていません。" },
      { status: 503 },
    );
  const info = await fetchYouTubeVideoInfo(id, key);
  if ("error" in info)
    return Response.json({ error: info.error }, { status: info.status });
  const captions = await fetchYouTubeTranscript(
    info.value.originalUrl,
    supadataKey,
    info.value,
  ).catch(() => ({
    script: "",
    notice: "字幕の取得に失敗しました。",
  }));
  // Only the form's own fields: description and youtubeStats go into the
  // script instead -- spread into the form, YouTube's view count would
  // overwrite this app's own.
  const video = info.value;
  return Response.json({
    preview: {
      title: video.title,
      channelName: video.channelName,
      originalUrl: video.originalUrl,
      thumbnailUrl: video.thumbnailUrl,
      channelThumbnailUrl: video.channelThumbnailUrl,
      publishedAt: video.publishedAt,
      duration: video.duration,
      detailedScript: detailedScriptMarkdown(video, captions.script),
    },
    captionNotice: captions.notice,
  });
});
