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

export function mockOutboundResponse(request: Request): Response {
  const url = new URL(request.url);
  if (url.hostname === "m.youtube.com") {
    return new Response(SAMPLE_YOUTUBE_WATCH_PAGE_HTML, { status: 200, headers: { "content-type": "text/html" } });
  }
  if (url.hostname === "www.googleapis.com" && url.pathname.includes("/videos")) {
    return new Response(SAMPLE_YOUTUBE_DATA_API_VIDEOS_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.hostname === "www.googleapis.com" && url.pathname.includes("/channels")) {
    return new Response(SAMPLE_YOUTUBE_DATA_API_CHANNELS_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.hostname === "api.supadata.ai") {
    return new Response(SAMPLE_SUPADATA_TRANSCRIPT_RESPONSE, { status: 200, headers: { "content-type": "application/json", "x-billable-requests": "1" } });
  }
  // Loud and diagnosable rather than a silent real network attempt (which
  // would fail or hang in CI anyway): any route that starts making a new
  // kind of outbound call needs a fixture added above, not a surprise 599
  // discovered from a flaky test.
  return new Response(`outbound-mocks.ts has no fixture for ${url.href}`, { status: 599 });
}
