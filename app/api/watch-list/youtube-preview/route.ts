import { youTubeVideoId } from "@/app/lib/youtube";
import { route } from "@/app/lib/route";

type YouTubePreview = {
  item: {
    seriesTitle: string;
    title: string;
    links: Array<{ label: string; url: string; linkType: "reference" }>;
  };
};

function attribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

function decodeHtml(value: string) {
  const named: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", "#39": "'" };
  return value.replace(/&#(x[\da-f]+|\d+);|&(quot|amp|lt|gt|#39);/gi, (match: string, numeric: string | undefined, entity: string | undefined) => {
    if (numeric) {
      const codePoint = numeric.toLowerCase().startsWith("x") ? Number.parseInt(numeric.slice(1), 16) : Number.parseInt(numeric, 10);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    }
    return named[(entity ?? "").toLowerCase()] ?? match;
  });
}

function tagContent(html: string, selector: (tag: string) => boolean) {
  return html.match(/<(?:meta|link)\b[^>]*>/gi)?.map((tag) => ({ tag, content: attribute(tag, "content") })).find(({ tag, content }) => content && selector(tag))?.content ?? "";
}

function channelName(html: string) {
  const jsonValue = html.match(/"ownerChannelName":"((?:\\.|[^"\\])*)"/)?.[1];
  if (jsonValue) {
    try { return JSON.parse(`"${jsonValue}"`).trim(); } catch { /* Try the metadata fallback. */ }
  }
  return decodeHtml(tagContent(html, (tag) => attribute(tag, "itemprop").toLowerCase() === "name")).trim();
}

type Metadata = { title: string; seriesTitle: string };
type ScrapeResult = { metadata: Metadata } | { failure: Response };

/** Reads the title and channel name from the public watch page. From Cloudflare's
 *  egress YouTube sometimes answers 200 with a "confirm you're not a bot" page
 *  (playabilityStatus LOGIN_REQUIRED) that carries neither, so the caller must
 *  be ready to fall back to oEmbed. */
async function scrapeWatchPage(videoId: string): Promise<ScrapeResult> {
  let html: string;
  try {
    const response = await fetch(`https://m.youtube.com/watch?v=${videoId}`, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1", accept: "text/html" } });
    if (!response.ok) return { failure: Response.json({ error: "YouTubeの動画ページを取得できませんでした。公開中の動画URLか確認してください。" }, { status: 422 }) };
    html = await response.text();
  } catch {
    return { failure: Response.json({ error: "YouTubeへ接続できませんでした。しばらくしてからもう一度お試しください。" }, { status: 502 }) };
  }

  const title = decodeHtml(tagContent(html, (tag) => attribute(tag, "property").toLowerCase() === "og:title")).trim();
  const seriesTitle = channelName(html);
  if (!title || !seriesTitle) return { failure: Response.json({ error: "動画情報を読み取れませんでした。公開済みの通常動画URLを指定してください。" }, { status: 422 }) };
  return { metadata: { title, seriesTitle } };
}

/** oEmbed is a documented, keyless endpoint that YouTube does not bot-check the
 *  way it does the watch page. It only knows embeddable public videos. */
async function fetchOEmbed(url: string): Promise<Metadata | null> {
  try {
    const response = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const data = await response.json() as { title?: unknown; author_name?: unknown } | null;
    const title = typeof data?.title === "string" ? data.title.trim() : "";
    const seriesTitle = typeof data?.author_name === "string" ? data.author_name.trim() : "";
    return title && seriesTitle ? { title, seriesTitle } : null;
  } catch {
    return null;
  }
}

export const POST = route(async (request: Request) => {
  const body = await request.json().catch(() => null) as { url?: unknown } | null;
  const videoId = youTubeVideoId(body?.url);
  if (!videoId) return Response.json({ error: "YouTube動画のURLを入力してください。" }, { status: 400 });

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const scraped = await scrapeWatchPage(videoId);
  let metadata: Metadata;
  if ("metadata" in scraped) {
    metadata = scraped.metadata;
  } else {
    const fallback = await fetchOEmbed(url);
    // Both sources failed: report the scrape's error, which is the more specific one.
    if (!fallback) return scraped.failure;
    metadata = fallback;
  }

  const preview: YouTubePreview = { item: { seriesTitle: metadata.seriesTitle, title: metadata.title, links: [{ label: "YouTube", url, linkType: "reference" }] } };
  return Response.json(preview);
});
