/** Pure decisions for Watch List thumbnails -- no I/O, so they run under
 *  vitest's plain-Node "node" project. The fetching lives in
 *  app/lib/thumbnail-fetch.ts.
 *
 *  A thumbnail comes from one of two places:
 *  - a YouTube link: the image URL is a fixed function of the video id, so it
 *    is derived every time an item is read and never stored (existing items
 *    get one without any lookup, and it can never go stale);
 *  - any other link: the page's og:image, fetched once when the item is saved
 *    and stored in items.thumbnail_url.
 *  Imports use explicit .ts extensions for the same reason as
 *  app/lib/watch-list-item-input.ts. */
import { attribute, decodeHtml, tagContent } from "./html-meta.ts";
import { youTubeVideoId } from "./youtube.ts";

/** i.ytimg.com serves mqdefault.jpg (320x180, 16:9, no letterbox bars) for
 *  every video, public or not. */
export function youTubeThumbnailUrl(videoId: string) {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

export function youTubeThumbnailFromLinks(links: Array<{ url?: unknown }>) {
  for (const link of links) {
    const videoId = youTubeVideoId(link.url);
    if (videoId) return youTubeThumbnailUrl(videoId);
  }
  return "";
}

/** True only for a URL the server may fetch on the user's behalf: http(s) on
 *  the default port, no credentials, and a public-looking host name. IP
 *  literals and single-label or local-only names are refused so a saved link
 *  cannot be used to make the Worker probe internal addresses. */
export function isPublicHttpUrl(value: unknown) {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host.includes(":") || /^[\d.]+$/.test(host)) return false;
  return !/\.(?:local|localhost|internal|lan|home|corp)$/.test(host) && host !== "localhost";
}

const imageSelectors = [
  (tag: string) => attribute(tag, "property").toLowerCase() === "og:image:secure_url",
  (tag: string) => attribute(tag, "property").toLowerCase() === "og:image",
  (tag: string) => ["twitter:image", "twitter:image:src"].includes(attribute(tag, "name").toLowerCase()),
];

/** The page's preview image as an absolute https URL, or "". Only https is
 *  accepted: the app is served over https, so an http image would be blocked
 *  as mixed content anyway. */
export function pageImageUrl(html: string, pageUrl: string) {
  for (const selector of imageSelectors) {
    const content = decodeHtml(tagContent(html, selector)).trim();
    if (!content) continue;
    try {
      const url = new URL(content, pageUrl);
      if (url.protocol === "https:" && url.href.length <= 2000) return url.href;
    } catch {
      /* Try the next candidate. */
    }
  }
  return "";
}

/** Where a page sends the browser with `<meta http-equiv="refresh"
 *  content="0;URL=...">`, as an absolute URL, or "". t.co (the link shortener
 *  used in tweets) answers a browser with exactly such a page -- and nothing
 *  else -- so its target's preview image is only reachable by following it. */
export function metaRefreshUrl(html: string, pageUrl: string) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (attribute(tag, "http-equiv").toLowerCase() !== "refresh") continue;
    const target = decodeHtml(attribute(tag, "content")).match(/^\s*\d*\s*;\s*url\s*=\s*['"]?([^'"\s]+)/i)?.[1];
    if (!target) continue;
    try {
      return new URL(target, pageUrl).href;
    } catch {
      /* Not a URL. */
    }
  }
  return "";
}

/** Whether an item's stored thumbnail is still the one for its links, so a
 *  save that did not touch the links does not fetch again. */
export function sameLinkSet(previous: string[], next: string[]) {
  return previous.length === next.length && previous.every((url, index) => url === next[index]);
}
