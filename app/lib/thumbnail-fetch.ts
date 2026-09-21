/** Server-side lookup of a page's preview image (og:image) for the Watch
 *  List. Only plain `fetch`, no Cloudflare bindings, so it is testable with
 *  the workers project's outbound mock. The decisions (which URL is safe to
 *  fetch, how to read the image out of the HTML) are in app/lib/thumbnail.ts.
 *
 *  Everything here is best effort: any failure -- timeout, non-HTML, a
 *  redirect to a refused host, no image tag -- resolves to "" rather than
 *  throwing, because a missing thumbnail must never fail saving an item. */
import { isPublicHttpUrl, pageImageUrl, youTubeThumbnailFromLinks } from "./thumbnail.ts";

/** One deadline for the whole lookup, redirects included. */
const TIMEOUT_MS = 4000;
const MAX_REDIRECTS = 3;
/** Preview tags live in <head>; there is no reason to read a whole page. */
const MAX_HTML_BYTES = 128 * 1024;
/** Links tried per item, so one save makes at most this many subrequests. */
const MAX_LINKS = 2;

async function readHead(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let html = "";
  let bytes = 0;
  try {
    while (bytes < MAX_HTML_BYTES && !/<\/head>/i.test(html)) {
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

async function lookup(url: string, signal: AbortSignal): Promise<string> {
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Checked on every hop: a public page can redirect to an internal host.
      if (!isPublicHttpUrl(current)) return "";
      const response = await fetch(current, {
        redirect: "manual",
        signal,
        headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", accept: "text/html" },
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        current = new URL(location, current).href;
        continue;
      }
      if (!response.ok) return "";
      if (!(response.headers.get("content-type") ?? "text/html").toLowerCase().includes("html")) return "";
      return pageImageUrl(await readHead(response), current);
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
