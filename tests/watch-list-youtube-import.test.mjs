import { expect, test } from "vitest";

import { applyYouTubePreview } from "../app/lib/watch-list-youtube-import.ts";

// applyYouTubePreview() is what the Watch List editor runs on the response of
// /api/watch-list/youtube-preview. The point of these tests is what it does NOT
// touch: fetching a video used to blank 人物・媒体 and replace every link.

const preview = {
  seriesTitle: "テレ東AIアカデミー【公式】",
  title: "取得したタイトル",
  links: [{ label: "YouTube", url: "https://www.youtube.com/watch?v=ftcDTWIT6ho", linkType: "reference" }],
};

const draft = (overrides = {}) => ({
  contentType: "audio",
  creatorName: "野田クリスタル",
  seriesTitle: "",
  title: "",
  description: "メモ",
  priority: 2,
  status: "in_progress",
  comment: "コメント",
  links: [{ label: "", url: "", linkType: "reference" }],
  ...overrides,
});

test("writes the channel name, title and link, and leaves every other field alone", () => {
  const result = applyYouTubePreview(draft(), preview);
  expect(result.seriesTitle).toBe("テレ東AIアカデミー【公式】");
  expect(result.title).toBe("取得したタイトル");
  expect(result.links).toEqual(preview.links);
  expect(result.creatorName).toBe("野田クリスタル");
  expect(result.contentType).toBe("audio");
  expect(result.description).toBe("メモ");
  expect(result.priority).toBe(2);
  expect(result.status).toBe("in_progress");
  expect(result.comment).toBe("コメント");
});

test("overwrites an existing channel name and title", () => {
  const result = applyYouTubePreview(draft({ seriesTitle: "古いチャンネル", title: "古いタイトル" }), preview);
  expect(result.seriesTitle).toBe("テレ東AIアカデミー【公式】");
  expect(result.title).toBe("取得したタイトル");
});

test("keeps the links already on the draft and appends the video link", () => {
  const existing = { id: "l1", label: "公式サイト", url: "https://example.com/", linkType: "reference" };
  const result = applyYouTubePreview(draft({ links: [existing] }), preview);
  expect(result.links).toEqual([existing, preview.links[0]]);
});

test("does not add the video link twice when it is already on the draft", () => {
  const existing = { id: "l1", label: "動画", url: "https://www.youtube.com/watch?v=ftcDTWIT6ho", linkType: "reference" };
  const result = applyYouTubePreview(draft({ links: [existing] }), preview);
  expect(result.links).toEqual([existing]);
});

test("keeps the current value when the preview field is blank", () => {
  const result = applyYouTubePreview(draft({ seriesTitle: "残す", title: "残す" }), { ...preview, seriesTitle: " ", title: "" });
  expect(result.seriesTitle).toBe("残す");
  expect(result.title).toBe("残す");
});
