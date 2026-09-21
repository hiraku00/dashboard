import { expect, test } from "vitest";
import { POST as youtubePreviewPost } from "@/app/api/watch-list/youtube-preview/route";
import { BOT_CHECKED_VIDEO_ID, UNAVAILABLE_VIDEO_ID } from "./fixtures/outbound-mocks";

// Replaces tests/rendered-html.test.mjs's "imports public YouTube page
// metadata into the Watch List editor" (Issue #94). That test only grepped
// the route's source for the scraped page's URL and field names -- it never
// actually called the route. This does, with the outbound fetches to
// m.youtube.com and www.youtube.com/oembed mocked (see
// tests/workers/fixtures/outbound-mocks.ts) since this route deliberately
// uses only public, keyless YouTube endpoints rather than an API that would
// need a credential. It scrapes the watch page first and falls back to oEmbed
// when YouTube answers Cloudflare's egress IP with a bot-check page.

test("scrapes the title and channel name from the public YouTube watch page", async () => {
  const response = await youtubePreviewPost(
    new Request("http://x/api/watch-list/youtube-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { item: { title: string; seriesTitle: string; links: Array<{ label: string; url: string }> } };
  // Only what the page told us: the route must not send placeholders (creatorName "",
  // contentType "movie") that the editor would then write over the user's own values.
  expect(Object.keys(body.item).sort()).toEqual(["links", "seriesTitle", "title"]);
  expect(body.item.title).toBe("Sample Video Title");
  expect(body.item.seriesTitle).toBe("Sample Channel");
  expect(body.item.links).toEqual([{ label: "YouTube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", linkType: "reference" }]);
});

test("rejects a non-YouTube URL before making any outbound request", async () => {
  const response = await youtubePreviewPost(
    new Request("http://x/api/watch-list/youtube-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/not-youtube" }),
    }),
  );
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: string };
  expect(body.error).toBe("YouTube動画のURLを入力してください。");
});

type PreviewBody = { item: { title: string; seriesTitle: string; links: Array<{ url: string }> }; error?: string };

test("falls back to oEmbed when the watch page is a bot-check page without metadata", async () => {
  const response = await youtubePreviewPost(
    new Request("http://x/api/watch-list/youtube-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${BOT_CHECKED_VIDEO_ID}` }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as PreviewBody;
  expect(body.item.title).toBe("Fallback Video Title");
  expect(body.item.seriesTitle).toBe("Fallback Channel");
  expect(body.item.links[0].url).toBe(`https://www.youtube.com/watch?v=${BOT_CHECKED_VIDEO_ID}`);
});

test("reports the watch-page error when oEmbed cannot resolve the video either", async () => {
  const response = await youtubePreviewPost(
    new Request("http://x/api/watch-list/youtube-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${UNAVAILABLE_VIDEO_ID}` }),
    }),
  );
  expect(response.status).toBe(422);
  const body = (await response.json()) as PreviewBody;
  expect(body.error).toBe("動画情報を読み取れませんでした。公開済みの通常動画URLを指定してください。");
});
