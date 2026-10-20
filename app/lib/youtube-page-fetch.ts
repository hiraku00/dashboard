/** YouTubeの動画URLから、動画タイトルとチャンネル名を読み取る(Watch Listの「リンクから入力」用)。
 *  公開の視聴ページを読み、bot確認ページが返ったときは oEmbed に切り替える。通信だけで Cloudflare のバインディングには触れない。 */
import { attribute, decodeHtml, tagContent } from "./html-meta.ts";

export type YouTubeMetadata = { title: string; seriesTitle: string };
export type YouTubeFetchResult = { metadata: YouTubeMetadata } | { error: string; status: number };

function channelName(html: string) {
  const jsonValue = html.match(/"ownerChannelName":"((?:\\.|[^"\\])*)"/)?.[1];
  if (jsonValue) {
    try { return JSON.parse(`"${jsonValue}"`).trim(); } catch { /* Try the metadata fallback. */ }
  }
  return decodeHtml(tagContent(html, (tag) => attribute(tag, "itemprop").toLowerCase() === "name")).trim();
}

/** Reads the title and channel name from the public watch page. From Cloudflare's
 *  egress YouTube sometimes answers 200 with a "confirm you're not a bot" page
 *  (playabilityStatus LOGIN_REQUIRED) that carries neither, so the caller must
 *  be ready to fall back to oEmbed. */
async function scrapeWatchPage(videoId: string): Promise<YouTubeFetchResult> {
  let html: string;
  try {
    const response = await fetch(`https://m.youtube.com/watch?v=${videoId}`, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1", accept: "text/html" } });
    if (!response.ok) return { error: "YouTubeの動画ページを取得できませんでした。公開中の動画URLか確認してください。", status: 422 };
    html = await response.text();
  } catch {
    return { error: "YouTubeへ接続できませんでした。しばらくしてからもう一度お試しください。", status: 502 };
  }

  const title = decodeHtml(tagContent(html, (tag) => attribute(tag, "property").toLowerCase() === "og:title")).trim();
  const seriesTitle = channelName(html);
  if (!title || !seriesTitle) return { error: "動画情報を読み取れませんでした。公開済みの通常動画URLを指定してください。", status: 422 };
  return { metadata: { title, seriesTitle } };
}

/** oEmbed is a documented, keyless endpoint that YouTube does not bot-check the
 *  way it does the watch page. It only knows embeddable public videos. */
async function fetchOEmbed(url: string): Promise<YouTubeMetadata | null> {
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

export async function fetchYouTubeMetadata(videoId: string): Promise<YouTubeFetchResult> {
  const scraped = await scrapeWatchPage(videoId);
  if ("metadata" in scraped) return scraped;
  const fallback = await fetchOEmbed(`https://www.youtube.com/watch?v=${videoId}`);
  // Both sources failed: report the scrape's error, which is the more specific one.
  return fallback ? { metadata: fallback } : scraped;
}
