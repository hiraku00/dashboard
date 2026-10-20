import { expect, test } from "vitest";

import { applyLinkPreview, linkLabel } from "../app/lib/watch-list-link-import.ts";

// applyLinkPreview() is what the Watch List editor runs on the response of
// /api/watch-list/link-preview. The point of these tests is what it does NOT
// touch: fetching a link used to blank 人物・媒体 and replace every link.

const YT = "https://www.youtube.com/watch?v=ftcDTWIT6ho";
const preview = { creatorName: "", seriesTitle: "テレ東AIアカデミー【公式】", title: "取得したタイトル" };
const ytLink = { label: "YouTube", url: YT, linkType: "reference" };

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
  const result = applyLinkPreview(draft(), preview, YT);
  expect(result.seriesTitle).toBe("テレ東AIアカデミー【公式】");
  expect(result.title).toBe("取得したタイトル");
  expect(result.links).toEqual([ytLink]);
  expect(result.creatorName).toBe("野田クリスタル");
  expect(result.contentType).toBe("audio");
  expect(result.description).toBe("メモ");
  expect(result.priority).toBe(2);
  expect(result.status).toBe("in_progress");
  expect(result.comment).toBe("コメント");
});

test("overwrites an existing channel name and title", () => {
  const result = applyLinkPreview(draft({ seriesTitle: "古いチャンネル", title: "古いタイトル" }), preview, YT);
  expect(result.seriesTitle).toBe("テレ東AIアカデミー【公式】");
  expect(result.title).toBe("取得したタイトル");
});

test("keeps the links already on the draft and appends the new link", () => {
  const existing = { id: "l1", label: "公式サイト", url: "https://example.com/", linkType: "reference" };
  const result = applyLinkPreview(draft({ links: [existing] }), preview, YT);
  expect(result.links).toEqual([existing, ytLink]);
});

test("does not add the link twice when it is already on the draft", () => {
  const existing = { id: "l1", label: "動画", url: YT, linkType: "reference" };
  const result = applyLinkPreview(draft({ links: [existing] }), preview, YT);
  expect(result.links).toEqual([existing]);
});

test("keeps the current value when the preview field is blank", () => {
  const result = applyLinkPreview(draft({ seriesTitle: "残す", title: "残す" }), { ...preview, seriesTitle: " ", title: "" }, YT);
  expect(result.seriesTitle).toBe("残す");
  expect(result.title).toBe("残す");
});

test("a TV site's broadcaster fills 人物・媒体 only while it is blank", () => {
  const nhk = { creatorName: "NHK", seriesTitle: "クローズアップ現代", title: "回のタイトル" };
  const url = "https://www.web.nhk/tv/an/gendai/pl/series-tep-ABCDEFGHIJ/ep/KLMNOPQRST";
  expect(applyLinkPreview(draft({ creatorName: "" }), nhk, url).creatorName).toBe("NHK");
  expect(applyLinkPreview(draft({ creatorName: "野田クリスタル" }), nhk, url).creatorName).toBe("野田クリスタル");
  expect(applyLinkPreview(draft({ creatorName: "" }), nhk, url).links).toEqual([{ label: "NHK ONE", url, linkType: "reference" }]);
});

test("link labels: known sites by name, YouTube, otherwise the domain", () => {
  expect(linkLabel(YT)).toBe("YouTube");
  expect(linkLabel("https://youtu.be/ftcDTWIT6ho")).toBe("YouTube");
  expect(linkLabel("https://txbiz.tv-tokyo.co.jp/wbs/")).toBe("テレ東BIZ");
  expect(linkLabel("https://tver.jp/episodes/ept025uufz")).toBe("TVer");
  expect(linkLabel("https://www.example.com/a")).toBe("example.com");
});
