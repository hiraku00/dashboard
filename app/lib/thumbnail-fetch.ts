/** Server-side lookup of a page's preview image (og:image) for the Watch
 *  List. Only plain `fetch`, no Cloudflare bindings, so it is testable with
 *  the workers project's outbound mock. The decisions (which URL is safe to
 *  fetch, how to read the image out of the HTML) are in app/lib/thumbnail.ts.
 *
 *  Everything here is best effort: any failure -- timeout, non-HTML, a
 *  redirect to a refused host, no image tag -- resolves to "" rather than
 *  throwing, because a missing thumbnail must never fail saving an item. */
import { parseLinkPreview, parseTverPreview, tverEpisodeId, type LinkPreview } from "./link-preview.ts";
import { isPublicHttpUrl, metaRefreshUrl, pageImageUrl, tverThumbnailUrl, youTubeThumbnailFromLinks } from "./thumbnail.ts";

/** One deadline for the whole lookup, redirects included. */
const TIMEOUT_MS = 4000;
const MAX_REDIRECTS = 3;
/** Preview tags live in <head>; there is no reason to read a whole page. */
const MAX_HTML_BYTES = 128 * 1024;
/** Statuses that mean "not right now" rather than "not here". NHK, for one,
 *  answers Cloudflare's egress IPs with 403 only some of the time -- measured at
 *  the edge, the same page failed once and then succeeded twice in a row -- so a
 *  single refusal is not a reason to give up on a page. 404 and the like are not
 *  in the list: those pages are gone. */
const RETRY_STATUSES = new Set([403, 429, 500, 502, 503, 504]);
/** Waits before the 2nd and 3rd attempt. Short, because the whole lookup shares
 *  one 4s deadline and a save is waiting on it. */
const RETRY_DELAYS_MS = [300, 700];

/** The link preview is a button the person waits on (nothing else is blocked), and some TV sites answer slowly -- テレ東BIZ takes
 *  1.5-2.5s to the first byte -- so it gets a longer deadline than the thumbnail lookup that a save waits on. */
const PREVIEW_TIMEOUT_MS = 8000;

const TVER_CONTENT = "https://statics.tver.jp/content";

/** TVer の公開JSON(認証なし)を1つ読む。読めなければ null。 */
async function fetchTverJson(kind: "episode" | "series", id: string, signal: AbortSignal): Promise<unknown> {
  try {
    const response = await fetch(`${TVER_CONTENT}/${kind}/${id}.json`, { signal, headers: { accept: "application/json" } });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

/** TVer のエピソードの番組情報。ページのHTMLは空の殻なので、公開JSONから読む(エピソード→そのシリーズ)。読めなければ null。 */
export async function fetchTverPreview(episodeId: string, timeoutMs = PREVIEW_TIMEOUT_MS): Promise<LinkPreview | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
  });
  const read = async () => {
    const episode = await fetchTverJson("episode", episodeId, controller.signal);
    if (!episode || typeof episode !== "object") return null;
    const seriesId = (episode as { seriesID?: unknown }).seriesID;
    const series = typeof seriesId === "string" && seriesId ? await fetchTverJson("series", seriesId, controller.signal) : null;
    return parseTverPreview(episode, series);
  };
  try {
    return await Promise.race([read(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Links tried per item, so one save makes at most this many subrequests. */
const MAX_LINKS = 2;

async function readHead(response: Response, stopAtHeadEnd = true) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let html = "";
  let bytes = 0;
  try {
    while (bytes < MAX_HTML_BYTES && !(stopAtHeadEnd && /<\/head>/i.test(html))) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      html += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return html;
}

/** One page fetch, retried a couple of times when the answer is a transient
 *  refusal. Every attempt is a subrequest, which a Worker has few of; that is
 *  why only those statuses are retried and only twice. */
async function fetchPage(url: string, signal: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      redirect: "manual",
      signal,
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", accept: "text/html" },
    });
    if (!RETRY_STATUSES.has(response.status) || attempt >= RETRY_DELAYS_MS.length) return response;
    await response.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }
}

async function lookup(url: string, signal: AbortSignal): Promise<string> {
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Checked on every hop: a public page can redirect to an internal host.
      if (!isPublicHttpUrl(current)) return "";
      const response = await fetchPage(current, signal);
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        current = new URL(location, current).href;
        continue;
      }
      if (!response.ok) return "";
      if (!(response.headers.get("content-type") ?? "text/html").toLowerCase().includes("html")) return "";
      const head = await readHead(response);
      const image = pageImageUrl(head, current);
      if (image) return image;
      // A page with no image that only redirects (t.co): follow it, within the
      // same hop budget and the same public-host check as an HTTP redirect.
      const next = metaRefreshUrl(head, current);
      if (!next) return "";
      current = next;
    }
  } catch {
    /* Best effort. */
  }
  return "";
}

/** The page's preview image, or "" if there is none or it could not be
 *  reached in time.
 *
 *  The deadline is a timer raced against the lookup, with the abort as
 *  cleanup, rather than `AbortSignal.timeout()` alone: a host whose DNS lookup
 *  hangs (measured: ~30s to fail for one) kept the fetch pending well past the
 *  signal in the local runtime, and this runs inside a request the user is
 *  waiting on. */
export async function fetchPageThumbnail(url: string): Promise<string> {
  const tver = tverThumbnailUrl(url);
  if (tver) return tver;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<string>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(""); }, TIMEOUT_MS);
  });
  try {
    return await Promise.race([lookup(url, controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The image to store for an item with these links: "" when a YouTube link
 *  makes storing unnecessary (its thumbnail is derived on read), otherwise the
 *  first link's page image, falling back to the next. */
export async function resolveStoredThumbnail(urls: string[]): Promise<string> {
  if (youTubeThumbnailFromLinks(urls.map((url) => ({ url })))) return "";
  const found = await Promise.all(urls.slice(0, MAX_LINKS).map(fetchPageThumbnail));
  return found.find(Boolean) ?? "";
}

/** The first 128KB of a page (redirects followed, each hop checked as public), or null if it could not be read in time. Used by
 *  the link preview, which reads the title and program name rather than the image. It reads past </head> on purpose: NHK ONE puts
 *  the program name (JSON-LD partOfSeries) in the body, ~50KB in. */
export async function fetchPageHead(url: string, timeoutMs = PREVIEW_TIMEOUT_MS): Promise<{ html: string; url: string } | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
  });
  const read = async () => {
    try {
      let current = url;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (!isPublicHttpUrl(current)) return null;
        const response = await fetchPage(current, controller.signal);
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) { current = new URL(location, current).href; continue; }
        if (!response.ok || !(response.headers.get("content-type") ?? "text/html").toLowerCase().includes("html")) return null;
        return { html: await readHead(response, false), url: current };
      }
    } catch { /* Best effort. */ }
    return null;
  };
  try {
    return await Promise.race([read(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** リンク先から読み取った番組情報と、(転送を辿った後の)ページのURL。TVer は公開JSON、ほかは HTML から読む。読めなければ null。
 *  詳細画面の「リンクから取得」と、同期の完了時の自動入力が、同じこの読み取りを使う。 */
export async function fetchLinkPreview(url: string): Promise<{ preview: LinkPreview; url: string } | null> {
  if (tverEpisodeId(url)) {
    const preview = await fetchTverPreview(tverEpisodeId(url));
    return preview ? { preview, url } : null;
  }
  const page = await fetchPageHead(url);
  return page ? { preview: parseLinkPreview(page.html, page.url), url: page.url } : null;
}
