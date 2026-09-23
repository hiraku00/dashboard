import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { ensureSchema } from "@/db";
import { POST as textTubePreviewPost } from "@/app/api/text-tube/youtube-preview/route";
import { LANG_MISMATCH_VIDEO_ID } from "./fixtures/outbound-mocks";

// Replaces tests/rendered-html.test.mjs's "imports TextTube captions
// through the managed transcript API and records actual usage" (Issue #94).
// That test only grepped source files for the Supadata endpoint, "native"
// mode, the usage-header name, and the D1 table name -- it never actually
// called the route or confirmed a usage row gets written. This does,
// against a real D1 (for the usage row) with the YouTube Data API and
// Supadata calls mocked (see tests/workers/fixtures/outbound-mocks.ts).

beforeAll(async () => {
  await ensureSchema({ seed: false });
});

test("fetches video metadata and a transcript, and records Supadata usage in D1", async () => {
  const before = await env.DB.prepare("SELECT COUNT(*) AS c FROM text_tube_api_usage WHERE provider='supadata'").first<{ c: number }>();

  const response = await textTubePreviewPost(
    new Request("http://x/api/text-tube/youtube-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { preview: { title: string; channelName: string; duration: string; detailedScript: string } };
  expect(body.preview.title).toBe("Sample Video");
  expect(body.preview.channelName).toBe("Sample Channel");
  expect(body.preview.duration).toBe("05:30");
  // The scraped-page route (watch-list-youtube-preview.test.ts) never
  // fetches captions at all; this is what actually distinguishes TextTube's
  // preview from Watch List's.
  expect(body.preview.detailedScript).toContain("sample caption line");

  const after = await env.DB.prepare("SELECT COUNT(*) AS c FROM text_tube_api_usage WHERE provider='supadata'").first<{ c: number }>();
  expect(after!.c).toBe(before!.c + 1);
});

// Reproduces the real bug report this retry fixes: requesting lang=ja for a
// video that has no Japanese captions does not fall back to the video's own
// language -- Supadata returns "whichever language is available first"
// (its own docs' wording), observed in production as an English video's
// captions coming back in Arabic. See outbound-mocks.ts's
// LANG_MISMATCH_VIDEO_ID fixture for the two-request exchange this test
// exercises (lang=ja -> Arabic with English also available, then a retry
// for lang=en -> English).
test("retries in English when the Japanese-requested transcript comes back in an unrelated language", async () => {
  const before = await env.DB.prepare("SELECT COUNT(*) AS c FROM text_tube_api_usage WHERE provider='supadata'").first<{ c: number }>();

  const response = await textTubePreviewPost(
    new Request("http://x/api/text-tube/youtube-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${LANG_MISMATCH_VIDEO_ID}` }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { preview: { detailedScript: string }; captionNotice: string };
  // The English retry's content, not the Arabic first attempt's.
  expect(body.preview.detailedScript).toContain("english caption line");
  expect(body.preview.detailedScript).not.toContain("arabic caption line");
  expect(body.captionNotice).toBe("");

  // Both the initial (ja) request and the retry (en) request are real
  // Supadata calls and both cost credits -- both must be recorded.
  const after = await env.DB.prepare("SELECT COUNT(*) AS c FROM text_tube_api_usage WHERE provider='supadata'").first<{ c: number }>();
  expect(after!.c).toBe(before!.c + 2);
});
