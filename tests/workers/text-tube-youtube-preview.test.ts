import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { ensureSchema } from "@/db";
import { POST as textTubePreviewPost } from "@/app/api/text-tube/youtube-preview/route";

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
