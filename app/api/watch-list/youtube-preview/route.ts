import { youTubeVideoId } from "@/app/lib/youtube";

type YouTubePreview = {
  item: {
    contentType: "movie";
    creatorName: string;
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

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { url?: unknown } | null;
  const videoId = youTubeVideoId(body?.url);
  if (!videoId) return Response.json({ error: "YouTube動画のURLを入力してください。" }, { status: 400 });

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const metadataUrl = `https://m.youtube.com/watch?v=${videoId}`;
  let html: string;
  try {
    const response = await fetch(metadataUrl, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1", accept: "text/html" } });
    if (!response.ok) return Response.json({ error: "YouTubeの動画ページを取得できませんでした。公開中の動画URLか確認してください。" }, { status: 422 });
    html = await response.text();
  } catch {
    return Response.json({ error: "YouTubeへ接続できませんでした。しばらくしてからもう一度お試しください。" }, { status: 502 });
  }

  const title = decodeHtml(tagContent(html, (tag) => attribute(tag, "property").toLowerCase() === "og:title")).trim();
  const seriesTitle = channelName(html);
  if (!title || !seriesTitle) return Response.json({ error: "動画情報を読み取れませんでした。公開済みの通常動画URLを指定してください。" }, { status: 422 });

  const preview: YouTubePreview = { item: { contentType: "movie", creatorName: "", seriesTitle, title, links: [{ label: "YouTube", url, linkType: "reference" }] } };
  return Response.json(preview);
}
