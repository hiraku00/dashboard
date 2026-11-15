import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { ensureSchema } from "@/db";
import { POST as textTubePreviewPost } from "@/app/api/text-tube/youtube-preview/route";
import { JA_TITLE_VIDEO_ID, LANG_MISMATCH_VIDEO_ID } from "./fixtures/outbound-mocks";

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
  // Above the captions: what the video's YouTube page shows from the title
  // down to the end of the description.
  expect(body.preview.detailedScript).toBe(
    [
      "# 動画情報",
      "",
      "- タイトル: Sample Video",
      "- チャンネル: Sample Channel(登録者 21.4万人)",
      "- 公開日 2026-01-01 / 56,401回視聴 / 高評価 668",
      "",
      "## 概要欄",
      "",
      "Sample description line",
      "https://example.com/full/link/not/truncated",
      "#sample",
      "",
      "# 字幕",
      "",
      "- 00:01 sample caption line",
    ].join("\n"),
  );
  // YouTube's view count goes into the script only -- spread into the form,
  // it would overwrite this app's own view count.
  expect(body.preview).not.toHaveProperty("youtubeStats");
  expect(body.preview).not.toHaveProperty("description");
  expect(body.preview).not.toHaveProperty("viewCount");

  const after = await env.DB.prepare("SELECT COUNT(*) AS c FROM text_tube_api_usage WHERE provider='supadata'").first<{ c: number }>();
  expect(after!.c).toBe(before!.c + 1);
});

// Reproduces the real bug report this retry fixes: requesting a video's
// own language (from YouTube Data API's snippet.defaultAudioLanguage) does
// not fall back to it when that language has no captions -- Supadata
// returns "whichever language is available first" (its own docs' wording),
// observed in production as an English video's captions coming back in
// Arabic. See outbound-mocks.ts's LANG_MISMATCH_VIDEO_ID fixture for the
// two-request exchange this test exercises (a video whose own language is
// French but has no French captions: lang=fr -> Arabic with English also
// available, then a retry for lang=en -> English).
test("retries in English when the transcript in the video's own language comes back in an unrelated language instead", async () => {
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

// A Japanese video whose defaultAudioLanguage says English (auto-dubbed
// English audio brings English captions with it) used to come back with
// those English captions. Kana in the title marks it as Japanese.
test("requests Japanese captions for a video with a Japanese title even when its defaultAudioLanguage says English", async () => {
  const response = await textTubePreviewPost(
    new Request("http://x/api/text-tube/youtube-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${JA_TITLE_VIDEO_ID}` }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { preview: { detailedScript: string }; captionNotice: string };
  expect(body.preview.detailedScript).toContain("ja caption line");
  expect(body.preview.detailedScript).not.toContain("en caption line");
  expect(body.captionNotice).toBe("");
});
