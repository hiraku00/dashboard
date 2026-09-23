/** YouTube Data API + Supadata の呼び出しを1本化したもの。
 *
 *  もともと app/api/text-tube/youtube-preview/route.ts の中に直接書かれて
 *  いたが、Watch Listから自動で取り込む機能
 *  (app/lib/text-tube-import.ts) も同じ取得が必要になったため、ここへ
 *  切り出した。プレビュー画面（人が結果を見てから保存する）と自動取り込み
 *  （そのまま保存する）の両方がこれを呼ぶので、片方だけ直して挙動が
 *  ずれる、ということが起きない。 */
import { env } from "cloudflare:workers";

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

export type YouTubeVideoInfo = {
  title: string;
  channelName: string;
  originalUrl: string;
  thumbnailUrl: string;
  channelThumbnailUrl: string;
  publishedAt: string;
  duration: string;
  // BCP 47 (e.g. "en-US"), set by whoever uploaded the video, not always
  // present -- fetchYouTubeTranscript()'s primaryLangSubtag() normalizes it
  // and falls back to English when it's missing.
  defaultAudioLanguage?: string;
};

/** Fetches title/channel/thumbnails/duration/language for one video id via
 *  the YouTube Data API (`videos` then `channels`, for the channel's own
 *  thumbnail). Returns `{ value }` on success or `{ error, status }` on
 *  failure -- never throws, so callers (the preview route and the
 *  auto-import job) can each decide how to surface the failure without
 *  needing their own try/catch around this. */
export async function fetchYouTubeVideoInfo(
  videoId: string,
  key: string,
): Promise<{ value: YouTubeVideoInfo } | { error: string; status: number }> {
  try {
    const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
    videosUrl.search = new URLSearchParams({
      key,
      id: videoId,
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
      return {
        error:
          videosResponse.status === 403
            ? "YouTube Data APIの利用上限に達しているか、APIキーが無効です。"
            : (errorBody?.error?.message ??
              "YouTubeから動画情報を取得できませんでした。"),
        status: 502,
      };
    }
    const data = (await videosResponse.json()) as {
      items?: Array<{
        snippet?: {
          title?: string;
          channelTitle?: string;
          channelId?: string;
          publishedAt?: string;
          thumbnails?: Record<string, { url?: string }>;
          defaultAudioLanguage?: string;
        };
        contentDetails?: { duration?: string };
      }>;
    };
    const video = data.items?.[0];
    const snippet = video?.snippet;
    if (!snippet?.title || !snippet.channelId)
      return {
        error: "動画情報を取得できませんでした。公開中の動画URLか確認してください。",
        status: 422,
      };
    const channelsUrl = new URL(
      "https://www.googleapis.com/youtube/v3/channels",
    );
    channelsUrl.search = new URLSearchParams({
      key,
      id: snippet.channelId,
      part: "snippet",
    }).toString();
    // Channel thumbnail is decorative -- a failure here shouldn't fail the
    // whole lookup, so its response is read leniently rather than checked
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
    return {
      value: {
        title: snippet.title,
        channelName: snippet.channelTitle ?? "",
        originalUrl: `https://www.youtube.com/watch?v=${videoId}`,
        thumbnailUrl: pick(snippet.thumbnails),
        channelThumbnailUrl: pick(channel.items?.[0]?.snippet?.thumbnails),
        publishedAt: snippet.publishedAt?.slice(0, 10) ?? "",
        duration: duration(video?.contentDetails?.duration ?? ""),
        defaultAudioLanguage: snippet.defaultAudioLanguage,
      },
    };
  } catch {
    return {
      error: "YouTubeへ接続できませんでした。しばらくしてからもう一度お試しください。",
      status: 502,
    };
  }
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

/** YouTube's `defaultAudioLanguage` is a BCP 47 tag (e.g. "en-US", "ja")
 *  while Supadata's `lang` is a bare ISO 639-1 code -- take the primary
 *  subtag. Returns "" for anything that isn't a 2-letter code up front
 *  (missing field, or a script/region-only tag with no language part),
 *  which callers treat as "unknown, fall back to English". */
function primaryLangSubtag(tag: string | undefined) {
  const code = (tag ?? "").split(/[-_]/)[0].toLowerCase();
  return /^[a-z]{2}$/.test(code) ? code : "";
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
 *  fetchYouTubeTranscript()'s job, not this one's, since it also has to
 *  decide whether to retry with a different `lang`. */
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

/** Fetches a video's transcript, timestamped and formatted as Markdown.
 *  `sourceLang` should be the video's own `defaultAudioLanguage` (from
 *  fetchYouTubeVideoInfo()) when known. Never throws -- a failure comes
 *  back as `{ script: "", notice: "<Japanese message>" }`. */
export async function fetchYouTubeTranscript(
  url: string,
  key: string | undefined,
  sourceLang: string | undefined,
) {
  if (!key) return { script: "", notice: "字幕APIが未設定です。" };
  const headers = { "x-api-key": key.trim() };
  // Request the video's own spoken-language track first, not a translated
  // one: a native caption (human-written, or YouTube's own speech-to-text
  // in that language) is more accurate than any machine translation of it,
  // and that holds however this app's reader happens to read. `sourceLang`
  // comes from YouTube Data API's snippet.defaultAudioLanguage (set by
  // whoever uploaded the video); when YouTube has no answer for that,
  // English is the most likely single guess to have a native track.
  const preferredLang = primaryLangSubtag(sourceLang) || "en";
  let { response, body } = await requestTranscript(url, headers, preferredLang);
  // mode=native does not fall back to the video's own language when the
  // requested one has no track -- Supadata's own docs say it "returns a
  // transcript in whichever language is available first", which is
  // effectively arbitrary (observed: requesting a language a video has no
  // native captions in came back in Arabic, unrelated to either the
  // request or the video). If that happened here, preferredLang wasn't
  // already English (retrying the same request we just made would just
  // repeat it), and an English track exists, retry once for English --
  // still not the video's own language, but far more likely to be usable
  // than a third, unrelated language chosen for us.
  if (
    response.ok &&
    body.content &&
    body.lang &&
    body.lang !== preferredLang &&
    preferredLang !== "en" &&
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
  // preferredLang (the video's own language, or English when that was
  // unknown) and English (the retry above) were what we asked for; anything
  // else means neither had a native track and the reader should know the
  // script isn't in either language they'd expect. preferredLang is
  // already "en" when the video's language was unknown, so that case names
  // only one language rather than repeating "英語".
  const askedFor =
    preferredLang === "en" ? "英語" : `${langLabel(preferredLang)}・英語`;
  const notice =
    body.lang && body.lang !== preferredLang && body.lang !== "en"
      ? `${askedFor}の字幕が見つからず、${langLabel(body.lang)}の字幕を取得しました。`
      : "";
  return { script: `# 字幕\n\n${lines.join("\n")}`, notice };
}
