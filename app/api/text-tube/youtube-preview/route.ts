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
  // The language actually returned, and every language Supadata has a
  // native track for -- present on both the immediate (200) and the
  // completed-job (202 polling) response. See requestTranscript()'s
  // comment for why these matter.
  lang?: string;
  availableLangs?: string[];
};

const preferredLangLabel = new Intl.DisplayNames(["ja"], { type: "language" });

function langLabel(code: string) {
  try {
    return preferredLangLabel.of(code) ?? code;
  } catch {
    return code;
  }
}

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

/** One Supadata request for `lang`, including the async job's polling loop
 *  when it returns 202. Returns whatever HTTP response and body the request
 *  (or its completed/failed job) ended on -- interpreting that is
 *  transcript()'s job, not this one's, since it also has to decide whether
 *  to retry with a different `lang`. */
async function requestTranscript(
  url: string,
  headers: Record<string, string>,
  lang: string,
): Promise<{ response: Response; body: SupadataTranscript }> {
  const endpoint = new URL("https://api.supadata.ai/v1/transcript");
  endpoint.search = new URLSearchParams({ url, lang, mode: "native" }).toString();
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
      if (job.status === "completed" || job.status === "failed") {
        body = job;
        break;
      }
    }
  }
  return { response, body };
}

async function transcript(url: string, key: string | undefined) {
  if (!key) return { script: "", notice: "字幕APIが未設定です。" };
  const headers = { "x-api-key": key.trim() };
  let { response, body } = await requestTranscript(url, headers, "ja");
  // mode=native with lang=ja does not fall back to the video's own
  // language when it has no Japanese captions -- Supadata's own docs say
  // it "returns a transcript in whichever language is available first",
  // which is effectively arbitrary (observed: an English video's captions
  // came back in Arabic). If that happened and an English track exists,
  // retry once for English specifically -- far more likely to be usable to
  // a Japanese reader than a third, unrelated language chosen for them.
  if (
    response.ok &&
    body.content &&
    body.lang &&
    body.lang !== "ja" &&
    body.lang !== "en" &&
    body.availableLangs?.includes("en")
  ) {
    ({ response, body } = await requestTranscript(url, headers, "en"));
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
  if (body.status === "failed")
    return {
      script: "",
      notice: body.message ?? body.error ?? "字幕の生成に失敗しました。",
    };
  if (!body.content)
    return {
      script: "",
      notice: "字幕の処理が完了しませんでした。しばらくしてから再度お試しください。",
    };
  const lines = body.content
    .map((segment) => {
      const seconds = Math.floor(Number(segment.offset ?? 0) / 1000);
      const timestamp = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
      return `- ${timestamp} ${String(segment.text ?? "").trim()}`;
    })
    .filter((line) => !line.endsWith(" "));
  if (!lines.length)
    return { script: "", notice: "字幕本文を読み取れませんでした。" };
  // Japanese/English were what we asked for; anything else means neither
  // was available (or the retry above never fired, e.g. no English track
  // either) and the reader should know the script isn't in a language they
  // necessarily asked for.
  const notice =
    body.lang && body.lang !== "ja" && body.lang !== "en"
      ? `日本語・英語の字幕が見つからず、${langLabel(body.lang)}の字幕を取得しました。`
      : "";
  return { script: `# 字幕\n\n${lines.join("\n")}`, notice };
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
    const videosResponse = await fetch(videosUrl, {
      signal: AbortSignal.timeout(10_000),
    });
    // Checked before reading the body: a quota/auth failure (403) or a bad
    // request (400) comes back as HTTP 200 items:[] would never distinguish
    // from "no such video id" -- both used to fall through to the generic
    // 422 below, so a revoked API key looked identical to a typo'd URL.
    if (!videosResponse.ok) {
      const errorBody = (await videosResponse.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      return Response.json(
        {
          error:
            videosResponse.status === 403
              ? "YouTube Data APIの利用上限に達しているか、APIキーが無効です。"
              : (errorBody?.error?.message ??
                "YouTubeから動画情報を取得できませんでした。"),
        },
        { status: 502 },
      );
    }
    const data = (await videosResponse.json()) as {
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
        { error: "動画情報を取得できませんでした。公開中の動画URLか確認してください。" },
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
    // Channel thumbnail is decorative -- a failure here shouldn't fail the
    // whole preview, so its response is read leniently rather than checked
    // like videosResponse above.
    const channel = (await (
      await fetch(channelsUrl, { signal: AbortSignal.timeout(10_000) })
    )
      .json()
      .catch(() => ({}))) as {
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
