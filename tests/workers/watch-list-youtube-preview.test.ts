import { expect, test } from "vitest";
import { POST as youtubePreviewPost } from "@/app/api/watch-list/youtube-preview/route";

// Replaces tests/rendered-html.test.mjs's "imports public YouTube page
// metadata into the Watch List editor" (Issue #94). That test only grepped
// the route's source for the scraped page's URL and field names, and for
// the ABSENCE of `googleapis.com|oembed` (guarding against reverting to a
// different, previously-broken approach) -- it never actually called the
// route. This does, with the outbound fetch to m.youtube.com mocked (see
// tests/workers/fixtures/outbound-mocks.ts) since this route deliberately
// scrapes the public watch page rather than calling an API that would need
// a credential.

test("scrapes the title and channel name from the public YouTube watch page", async () => {
  const response = await youtubePreviewPost(
    new Request("http://x/api/watch-list/youtube-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { item: { contentType: string; title: string; seriesTitle: string; links: Array<{ label: string; url: string }> } };
  expect(body.item.contentType).toBe("movie");
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
