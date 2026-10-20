import { expect, test } from "vitest";
import { POST as linkPreviewPost } from "@/app/api/watch-list/link-preview/route";
import { BOT_CHECKED_VIDEO_ID, UNAVAILABLE_VIDEO_ID } from "./fixtures/outbound-mocks";

// The YouTube branch of the shared link preview route. Replaces tests/rendered-html.test.mjs's "imports public YouTube page
// metadata into the Watch List editor" (Issue #94). That test only grepped
// the route's source for the scraped page's URL and field names -- it never
// actually called the route. This does, with the outbound fetches to
// m.youtube.com and www.youtube.com/oembed mocked (see
// tests/workers/fixtures/outbound-mocks.ts) since this route deliberately
// uses only public, keyless YouTube endpoints rather than an API that would
// need a credential. It scrapes the watch page first and falls back to oEmbed
// when YouTube answers Cloudflare's egress IP with a bot-check page.

type PreviewBody = { preview: { creatorName: string; title: string; seriesTitle: string }; url: string; error?: string };

test("scrapes the title and channel name from the public YouTube watch page", async () => {
  const response = await linkPreviewPost(
    new Request("http://x/api/watch-list/link-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as PreviewBody;
  // A video has no broadcaster: creatorName stays "" (the editor only fills 人物・媒体 while it is blank).
  expect(body.preview).toEqual({ creatorName: "", seriesTitle: "Sample Channel", title: "Sample Video Title" });
  expect(body.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
});

test("rejects a non-http URL before making any outbound request", async () => {
  const response = await linkPreviewPost(
    new Request("http://x/api/watch-list/link-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "ftp://example.com/video" }),
    }),
  );
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: string };
  expect(body.error).toBe("http:// または https:// で始まるURLを入力してください。");
});

test("falls back to oEmbed when the watch page is a bot-check page without metadata", async () => {
  const response = await linkPreviewPost(
    new Request("http://x/api/watch-list/link-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${BOT_CHECKED_VIDEO_ID}` }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as PreviewBody;
  expect(body.preview.title).toBe("Fallback Video Title");
  expect(body.preview.seriesTitle).toBe("Fallback Channel");
  expect(body.url).toBe(`https://www.youtube.com/watch?v=${BOT_CHECKED_VIDEO_ID}`);
});

test("reports the watch-page error when oEmbed cannot resolve the video either", async () => {
  const response = await linkPreviewPost(
    new Request("http://x/api/watch-list/link-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${UNAVAILABLE_VIDEO_ID}` }),
    }),
  );
  expect(response.status).toBe(422);
  const body = (await response.json()) as PreviewBody;
  expect(body.error).toBe("動画情報を読み取れませんでした。公開済みの通常動画URLを指定してください。");
});
