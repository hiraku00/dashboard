import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { youTubeVideoId } from "@/app/lib/youtube";
import { route } from "@/app/lib/route";

function pick(value: Record<string, { url?: string }> | undefined) {
  return (
    ["maxres", "standard", "high", "medium", "default"]
      .map((key) => value?.[key]?.url ?? "")
      .find(Boolean) ?? ""
  );
}

function duration(value: string) {
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return "";
  const seconds =
    Number(match[1] ?? 0) * 3600 +
    Number(match[2] ?? 0) * 60 +
    Number(match[3] ?? 0);
  return [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((part, index) =>
      index === 0 && !part ? "" : String(part).padStart(2, "0"),
    )
    .filter(Boolean)
    .join(":");
}

type SupadataTranscript = {
  content?: Array<{ text?: string; offset?: number }>;
  error?: string;
  message?: string;
  jobId?: string;
  status?: "queued" | "active" | "completed" | "failed";
};

async function recordSupadataUsage(response: Response) {
  const credits = Math.max(
    0,
    Number(response.headers.get("x-billable-requests") ?? 0) || 0,
  );
  await env.DB.prepare(
    "INSERT INTO text_tube_api_usage (id,provider,operation,http_status,credits,created_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      "supadata",
      "transcript-native",
      response.status,
      credits,
      new Date().toISOString(),
    )
    .run();
}

async function transcript(url: string, key: string | undefined) {
  if (!key) return { script: "", notice: "字幕APIが未設定です。" };
  const endpoint = new URL("https://api.supadata.ai/v1/transcript");
  endpoint.search = new URLSearchParams({
    url,
    lang: "ja",
    mode: "native",
  }).toString();
  const headers = { "x-api-key": key.trim() };
  const response = await fetch(endpoint, {
    headers,
    signal: AbortSignal.timeout(45_000),
  });
  await recordSupadataUsage(response);
  let body = (await response.json().catch(() => ({}))) as SupadataTranscript;
  if (response.status === 202 && body.jobId) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const jobResponse = await fetch(
        `https://api.supadata.ai/v1/transcript/${encodeURIComponent(body.jobId)}`,
        { headers, signal: AbortSignal.timeout(10_000) },
      );
      const job = (await jobResponse.json().catch(() => ({}))) as SupadataTranscript;
      if (job.status === "completed") {
        body = job;
        break;
      }
      if (job.status === "failed") {
        return {
          script: "",
          notice: job.message ?? job.error ?? "字幕の生成に失敗しました。",
        };
      }
    }
  }
  if (response.status === 206)
    return {
      script: "",
      notice: "この動画には取得可能なYouTube字幕がありません。",
    };
  if (!response.ok)
    return {
      script: "",
      notice:
        response.status === 401
          ? "SupadataのAPIキーが認証されませんでした。キーを再確認してください。"
          : (body.message ?? body.error ?? "字幕APIから取得できませんでした。"),
    };
  if (response.status === 202 && !body.content)
    return {
      script: "",
      notice: "字幕の処理が完了しませんでした。しばらくしてから再度お試しください。",
    };
  const lines = (body.content ?? [])
    .map((segment) => {
      const seconds = Math.floor(Number(segment.offset ?? 0) / 1000);
      const timestamp = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
      return `- ${timestamp} ${String(segment.text ?? "").trim()}`;
    })
    .filter((line) => !line.endsWith(" "));
  return {
    script: lines.length ? `# 字幕\n\n${lines.join("\n")}` : "",
    notice: lines.length ? "" : "字幕本文を読み取れませんでした。",
  };
}

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
  try {
    const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
    videosUrl.search = new URLSearchParams({
      key,
      id,
      part: "snippet,contentDetails",
    }).toString();
    const data = (await (await fetch(videosUrl)).json()) as {
      items?: Array<{
        snippet?: {
          title?: string;
          channelTitle?: string;
          channelId?: string;
          publishedAt?: string;
          thumbnails?: Record<string, { url?: string }>;
        };
        contentDetails?: { duration?: string };
      }>;
    };
    const video = data.items?.[0];
    const snippet = video?.snippet;
    if (!snippet?.title || !snippet.channelId)
      return Response.json(
        { error: "動画情報を取得できませんでした。" },
        { status: 422 },
      );
    const channelsUrl = new URL(
      "https://www.googleapis.com/youtube/v3/channels",
    );
    channelsUrl.search = new URLSearchParams({
      key,
      id: snippet.channelId,
      part: "snippet",
    }).toString();
    const channel = (await (await fetch(channelsUrl)).json()) as {
      items?: Array<{
        snippet?: { thumbnails?: Record<string, { url?: string }> };
      }>;
    };
    const captions = await transcript(
      `https://www.youtube.com/watch?v=${id}`,
      supadataKey,
    ).catch(() => ({
      script: "",
      notice: "字幕の取得に失敗しました。",
    }));
    return Response.json({
      preview: {
        title: snippet.title,
        channelName: snippet.channelTitle ?? "",
        originalUrl: `https://www.youtube.com/watch?v=${id}`,
        thumbnailUrl: pick(snippet.thumbnails),
        channelThumbnailUrl: pick(channel.items?.[0]?.snippet?.thumbnails),
        publishedAt: snippet.publishedAt?.slice(0, 10) ?? "",
        duration: duration(video?.contentDetails?.duration ?? ""),
        detailedScript: captions.script,
      },
      captionNotice: captions.notice,
    });
  } catch {
    return Response.json(
      {
        error:
          "YouTubeへ接続できませんでした。しばらくしてからもう一度お試しください。",
      },
      { status: 502 },
    );
  }
});
