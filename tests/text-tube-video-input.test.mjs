import assert from "node:assert/strict";
import test from "node:test";

import { videoInput } from "../app/lib/text-tube-video-input.ts";

// videoInput() is the pure validation/normalization app/api/text-tube/videos/route.ts's
// POST goes through before inserting a new video.

test("requires a non-empty title", () => {
  assert.equal(videoInput({}).error, "タイトルは必須です。");
  assert.equal(videoInput({ title: "   " }).error, "タイトルは必須です。");
});

test("trims and length-caps the title like clean() elsewhere", () => {
  const result = videoInput({ title: "  My Video  " });
  assert.equal(result.value?.title, "My Video");
});

test("viewCount is clamped to a non-negative integer, non-numeric falls back to 0", () => {
  assert.equal(videoInput({ title: "t", viewCount: -5 }).value?.viewCount, 0);
  assert.equal(videoInput({ title: "t", viewCount: "not-a-number" }).value?.viewCount, 0);
  assert.equal(videoInput({ title: "t", viewCount: 42 }).value?.viewCount, 42);
});

test("publishedAt defaults to null when blank", () => {
  assert.equal(videoInput({ title: "t" }).value?.publishedAt, null);
  assert.equal(videoInput({ title: "t", publishedAt: "2026-01-01" }).value?.publishedAt, "2026-01-01");
});

test("returns a full normalized value with all optional fields defaulted to empty strings", () => {
  const result = videoInput({ title: "t" });
  assert.deepEqual(result.value, {
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
