import { expect, test } from "vitest";

import { SUMMARY_MAX_LENGTH, videoInput } from "../app/lib/text-tube-video-input.ts";

// videoInput() is the pure validation/normalization app/api/text-tube/videos/route.ts's
// POST and app/api/text-tube/videos/[id]/route.ts's PATCH go through before writing a video.

test("requires a non-empty title", () => {
  expect(videoInput({}).error).toBe("タイトルは必須です。");
  expect(videoInput({ title: "   " }).error).toBe("タイトルは必須です。");
});

test("trims and length-caps the title like clean() elsewhere", () => {
  const result = videoInput({ title: "  My Video  " });
  expect(result.value?.title).toBe("My Video");
});

test("viewCount is clamped to a non-negative integer, non-numeric falls back to 0", () => {
  expect(videoInput({ title: "t", viewCount: -5 }).value?.viewCount).toBe(0);
  expect(videoInput({ title: "t", viewCount: "not-a-number" }).value?.viewCount).toBe(0);
  expect(videoInput({ title: "t", viewCount: 42 }).value?.viewCount).toBe(42);
});

test("publishedAt defaults to null when blank", () => {
  expect(videoInput({ title: "t" }).value?.publishedAt).toBe(null);
  expect(videoInput({ title: "t", publishedAt: "2026-01-01" }).value?.publishedAt).toBe("2026-01-01");
});

test("returns a full normalized value with all optional fields defaulted to empty strings", () => {
  const result = videoInput({ title: "t" });
  expect(result.value).toEqual({
    title: "t",
    channelName: "",
    thumbnailUrl: "",
    originalUrl: "",
    summary: "",
    publishedAt: null,
    viewCount: 0,
    channelThumbnailUrl: "",
    duration: "",
  });
});

test("keeps a summary longer than the old 30,000-character cap intact", () => {
  const summary = "あ".repeat(30_000) + "<p>15章の続き</p>";
  expect(videoInput({ title: "t", summary }).value?.summary).toBe(summary);
});

test("rejects a summary over the cap instead of silently cutting it", () => {
  expect(videoInput({ title: "t", summary: "a".repeat(SUMMARY_MAX_LENGTH) }).value?.summary.length).toBe(SUMMARY_MAX_LENGTH);
  const result = videoInput({ title: "t", summary: "a".repeat(SUMMARY_MAX_LENGTH + 1) });
  expect(result.value).toBeUndefined();
  expect(result.error).toContain("要約が長すぎます");
});
