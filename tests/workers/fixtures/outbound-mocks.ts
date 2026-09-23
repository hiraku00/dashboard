/** Canned responses for the external hosts app/api/watch-list/youtube-preview
 *  and app/api/text-tube/youtube-preview actually call, wired into
 *  vitest.config.ts's `miniflare.outboundService` (an undocumented but
 *  functional pass-through property on WorkersPoolOptions -- see Issue #94
 *  for how this was discovered and verified).
 *
 *  `outboundService` runs in a different execution context from the test
 *  files it serves (confirmed empirically: a module-level mutable object
 *  shared between a test file and this function does NOT see writes made
 *  from the test side), so per-test dynamic responses are not available --
 *  every request to a given host always gets the same canned reply. That is
 *  still enough to cover the "does the route hit the right host with the
 *  right params and parse the response into the right shape" behavior the
 *  rendered-html.test.mjs regex checks these replaced only asserted
 *  indirectly (by grepping the route's source for the URL/field names). */

export const SAMPLE_YOUTUBE_WATCH_PAGE_HTML = `<!doctype html><html><head>
<meta property="og:title" content="Sample Video Title">
<script>var ytInitialData = {"foo":{"ownerChannelName":"Sample Channel"}};</script>
</head><body></body></html>`;

/** YouTube's answer to a request from a flagged egress IP: HTTP 200, but a
 *  "confirm you're not a bot" page with no og:title or ownerChannelName. Video
 *  ids below opt into it, since the mock cannot vary per test. */
export const SAMPLE_YOUTUBE_BOT_CHECK_PAGE_HTML = `<!doctype html><html><head><title>YouTube</title>
<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LOGIN_REQUIRED","reason":"Sign in to confirm you're not a bot"}};</script>
</head><body></body></html>`;
export const BOT_CHECKED_VIDEO_ID = "botChecked1"; // watch page bot-checked, oEmbed works
export const UNAVAILABLE_VIDEO_ID = "unavailab1e"; // watch page bot-checked, oEmbed 404

export const SAMPLE_YOUTUBE_OEMBED_RESPONSE = JSON.stringify({ title: "Fallback Video Title", author_name: "Fallback Channel", provider_name: "YouTube" });

/** Hosts for the Watch List thumbnail lookup (app/lib/thumbnail-fetch.ts).
 *  `internal-target` answers as if it were a page with an image, so a test can
 *  tell "the redirect was refused" (no thumbnail) from "it was followed". */
export const THUMBNAIL_PAGE_HTML = `<!doctype html><html><head><title>Post</title>
<meta property="og:image" content="/img/cover.png">
</head><body></body></html>`;
export const THUMBNAIL_NO_IMAGE_HTML = `<!doctype html><html><head><title>Post</title></head><body></body></html>`;
export const THUMBNAIL_INTERNAL_HTML = `<!doctype html><html><head><meta property="og:image" content="https://evil.example.net/internal.png"></head></html>`;

/** t.co answers a browser with a tiny page whose only content is a meta refresh. */
export const refreshPageHtml = (target: string) => `<head><noscript><META http-equiv="refresh" content="0;URL=${target}"></noscript><title>${target}</title></head><script>location.replace("${target}")</script>`;

export const SAMPLE_YOUTUBE_DATA_API_VIDEOS_RESPONSE = JSON.stringify({
  items: [
    {
      snippet: {
        title: "Sample Video",
        channelTitle: "Sample Channel",
        channelId: "sample-channel-id",
        publishedAt: "2026-01-01T00:00:00Z",
        thumbnails: { high: { url: "https://example.com/thumb.jpg" } },
      },
      contentDetails: { duration: "PT5M30S" },
    },
  ],
});

export const SAMPLE_YOUTUBE_DATA_API_CHANNELS_RESPONSE = JSON.stringify({
  items: [{ snippet: { thumbnails: { high: { url: "https://example.com/channel-thumb.jpg" } } } }],
});

export const SAMPLE_SUPADATA_TRANSCRIPT_RESPONSE = JSON.stringify({
  content: [{ text: "sample caption line", offset: 1000 }],
});

/** A video id that makes the Supadata mock behave like the real bug report
 *  behind app/api/text-tube/youtube-preview/route.ts's English retry: the
 *  first request (lang=ja) comes back in a third, unrelated language
 *  (Arabic) with English also available, rather than in the video's own
 *  language. Branches on `lang` in the request itself rather than shared
 *  mutable state (see this file's own top comment on why that's the only
 *  way to vary a response within one test). */
export const LANG_MISMATCH_VIDEO_ID = "langMismat1";
export const SAMPLE_SUPADATA_TRANSCRIPT_MISMATCH_JA_RESPONSE = JSON.stringify({
  content: [{ text: "arabic caption line", offset: 1000 }],
  lang: "ar",
  availableLangs: ["ar", "en"],
});
export const SAMPLE_SUPADATA_TRANSCRIPT_MISMATCH_EN_RESPONSE = JSON.stringify({
  content: [{ text: "english caption line", offset: 1000 }],
  lang: "en",
  availableLangs: ["ar", "en"],
});

/** Hosts that refuse a page a fixed number of times before serving it, keyed by
 *  the full URL, so a test can tell how many attempts a lookup made: a lookup
 *  that gives up after N attempts leaves the (N+1)th to the next lookup. The
 *  counter lives in this module, which the outbound service keeps across
 *  requests. Use a fresh path per test. */
const flakySeen = new Map<string, number>();
const FLAKY_REFUSALS: Record<string, { status: number; times: number }> = {
  once: { status: 403, times: 1 },
  twice: { status: 403, times: 2 },
  thrice: { status: 403, times: 3 },
  throttled: { status: 429, times: 1 },
  unavailable: { status: 503, times: 1 },
  gone: { status: 404, times: 1 },
  always: { status: 403, times: Number.POSITIVE_INFINITY },
};

export function mockOutboundResponse(request: Request): Response {
  const url = new URL(request.url);
  if (url.hostname === "flaky.example.org") {
    const refusal = FLAKY_REFUSALS[url.pathname.split("/")[1]];
    const count = (flakySeen.get(request.url) ?? 0) + 1;
    flakySeen.set(request.url, count);
    if (refusal && count <= refusal.times) return new Response("refused", { status: refusal.status });
    return new Response(THUMBNAIL_PAGE_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (url.hostname === "m.youtube.com") {
    const videoId = url.searchParams.get("v");
    if (videoId === BOT_CHECKED_VIDEO_ID || videoId === UNAVAILABLE_VIDEO_ID) {
      return new Response(SAMPLE_YOUTUBE_BOT_CHECK_PAGE_HTML, { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response(SAMPLE_YOUTUBE_WATCH_PAGE_HTML, { status: 200, headers: { "content-type": "text/html" } });
  }
  if (url.hostname === "www.youtube.com" && url.pathname === "/oembed") {
    if (url.searchParams.get("url")?.includes(UNAVAILABLE_VIDEO_ID)) return new Response("Not Found", { status: 404 });
    return new Response(SAMPLE_YOUTUBE_OEMBED_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.hostname === "blog.example.org") {
    return new Response(THUMBNAIL_PAGE_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (url.hostname === "noimage.example.org") {
    return new Response(THUMBNAIL_NO_IMAGE_HTML, { status: 200, headers: { "content-type": "text/html" } });
  }
  if (url.hostname === "short.example.org") {
    return new Response(refreshPageHtml("https://blog.example.org/post"), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (url.hostname === "loop.example.org") {
    return new Response(refreshPageHtml("https://loop.example.org/again"), { status: 200, headers: { "content-type": "text/html" } });
  }
  if (url.hostname === "refresh-internal.example.org") {
    return new Response(refreshPageHtml("http://192.168.0.1/admin"), { status: 200, headers: { "content-type": "text/html" } });
  }
  if (url.hostname === "hop.example.org") {
    return new Response(null, { status: 302, headers: { location: "https://blog.example.org/post" } });
  }
  if (url.hostname === "sneaky.example.org") {
    return new Response(null, { status: 302, headers: { location: "http://192.168.0.1/admin" } });
  }
  if (url.hostname === "192.168.0.1") {
    return new Response(THUMBNAIL_INTERNAL_HTML, { status: 200, headers: { "content-type": "text/html" } });
  }
  if (url.hostname === "www.googleapis.com" && url.pathname.includes("/videos")) {
    return new Response(SAMPLE_YOUTUBE_DATA_API_VIDEOS_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.hostname === "www.googleapis.com" && url.pathname.includes("/channels")) {
    return new Response(SAMPLE_YOUTUBE_DATA_API_CHANNELS_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.hostname === "api.supadata.ai") {
    if (url.searchParams.get("url")?.includes(LANG_MISMATCH_VIDEO_ID)) {
      const body = url.searchParams.get("lang") === "en" ? SAMPLE_SUPADATA_TRANSCRIPT_MISMATCH_EN_RESPONSE : SAMPLE_SUPADATA_TRANSCRIPT_MISMATCH_JA_RESPONSE;
      return new Response(body, { status: 200, headers: { "content-type": "application/json", "x-billable-requests": "1" } });
    }
    return new Response(SAMPLE_SUPADATA_TRANSCRIPT_RESPONSE, { status: 200, headers: { "content-type": "application/json", "x-billable-requests": "1" } });
  }
  // Loud and diagnosable rather than a silent real network attempt (which
  // would fail or hang in CI anyway): any route that starts making a new
  // kind of outbound call needs a fixture added above, not a surprise 599
  // discovered from a flaky test.
  return new Response(`outbound-mocks.ts has no fixture for ${url.href}`, { status: 599 });
}
