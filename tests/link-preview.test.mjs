import { expect, test } from "vitest";

import { applyLinkPreview, parseLinkPreview } from "../app/lib/link-preview.ts";

const nhk = `<head><meta property="og:title" content="南米ペルー・海面水温上昇で漁業に打撃 | キャッチ!世界のトップニュース"/><title>南米ペルー・海面水温上昇で漁業に打撃 | キャッチ!世界のトップニュース | NHK</title></head>`;
const tx = `<head><title>暗号資産 イーサリアムとは【深読みリサーチ】｜テレ東BIZ</title><script>dataLayer.push({'event': 'pageview', 'title': 'x', 'program':'Newsモーニングサテライト（モーサテ）', 'member': 'n', });</script><meta property="og:title" content="暗号資産 イーサリアムとは【深読みリサーチ】｜テレ東BIZ"/></head>`;

test("NHK ONE: broadcaster NHK, program and episode split from og:title", () => {
  expect(parseLinkPreview(nhk, "https://www.web.nhk/tv/an/catchsekai/pl/series-tep-KQ2GPZPJWM/ep/14R8MPWCE1")).toEqual({ creatorName: "NHK", seriesTitle: "キャッチ!世界のトップニュース", title: "南米ペルー・海面水温上昇で漁業に打撃" });
});

test("テレ東BIZ: program is the short name in parentheses; the site suffix is dropped; a program top page has no episode title", () => {
  expect(parseLinkPreview(tx, "https://txbiz.tv-tokyo.co.jp/nms/special/post_349596")).toEqual({ creatorName: "テレ東", seriesTitle: "モーサテ", title: "暗号資産 イーサリアムとは【深読みリサーチ】" });
  const top = `<head><title>ワールドビジネスサテライト（WBS）｜テレ東BIZ</title><script>dataLayer.push({'program':'ワールドビジネスサテライト（WBS）', });</script></head>`;
  expect(parseLinkPreview(top, "https://txbiz.tv-tokyo.co.jp/wbs")).toEqual({ creatorName: "テレ東", seriesTitle: "WBS", title: "" });
});

test("an unknown site only gives the title, without its og:site_name suffix", () => {
  const html = `<head><meta property="og:title" content="記事 | Example"/><meta property="og:site_name" content="Example"/></head>`;
  expect(parseLinkPreview(html, "https://example.com/a")).toEqual({ creatorName: "", seriesTitle: "", title: "記事" });
});

test("applyLinkPreview fills blanks and fields still holding the last auto-fill, but keeps what the person typed", () => {
  const first = { creatorName: "NHK", seriesTitle: "A", title: "T1" };
  const second = { creatorName: "テレ東", seriesTitle: "B", title: "T2" };
  expect(applyLinkPreview({ creatorName: "", seriesTitle: "", title: "", n: 1 }, first, null)).toEqual({ ...first, n: 1 });
  expect(applyLinkPreview({ ...first }, second, first)).toEqual(second);
  expect(applyLinkPreview({ creatorName: "NHK", seriesTitle: "自分の番組名", title: "T1" }, second, first)).toEqual({ creatorName: "テレ東", seriesTitle: "自分の番組名", title: "T2" });
  expect(applyLinkPreview({ creatorName: "x", seriesTitle: "", title: "" }, { creatorName: "", seriesTitle: "", title: "" }, null)).toEqual({ creatorName: "x", seriesTitle: "", title: "" });
});

test("テレ東BIZ: a trailing ｜番組名 is dropped too, and a double-escaped & is restored", () => {
  const html = `<head><title>買い物をあきらめない！｜ガイアの夜明け</title><script>dataLayer.push({'program':'ガイアの夜明け', });</script><meta property="og:title" content="ノジマ M&amp;amp;Aで本腰｜ワールドビジネスサテライト（WBS）｜テレ東BIZ"/></head>`;
  expect(parseLinkPreview(html, "https://txbiz.tv-tokyo.co.jp/gaia/oa/post_1").title).toBe("ノジマ M&Aで本腰｜ワールドビジネスサテライト（WBS）");
  const gaia = `<head><title>買い物をあきらめない！｜ガイアの夜明け</title><script>dataLayer.push({'program':'ガイアの夜明け', });</script></head>`;
  expect(parseLinkPreview(gaia, "https://txbiz.tv-tokyo.co.jp/gaia/oa/post_1").title).toBe("買い物をあきらめない！");
});
