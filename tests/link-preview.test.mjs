import { expect, test } from "vitest";

import { parseLinkPreview } from "../app/lib/link-preview.ts";

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

test("テレ東BIZ: a trailing ｜番組名 is dropped too, and a double-escaped & is restored", () => {
  const html = `<head><title>買い物をあきらめない！｜ガイアの夜明け</title><script>dataLayer.push({'program':'ガイアの夜明け', });</script><meta property="og:title" content="ノジマ M&amp;amp;Aで本腰｜ワールドビジネスサテライト（WBS）｜テレ東BIZ"/></head>`;
  expect(parseLinkPreview(html, "https://txbiz.tv-tokyo.co.jp/gaia/oa/post_1").title).toBe("ノジマ M&Aで本腰｜ワールドビジネスサテライト（WBS）");
  const gaia = `<head><title>買い物をあきらめない！｜ガイアの夜明け</title><script>dataLayer.push({'program':'ガイアの夜明け', });</script></head>`;
  expect(parseLinkPreview(gaia, "https://txbiz.tv-tokyo.co.jp/gaia/oa/post_1").title).toBe("買い物をあきらめない！");
});

test("NHK ONE 番組表のページ(schedule-tep): og:title の後ろは日付と放送局なので使わず、JSON-LD の番組名を使う", () => {
  const html = `<head><meta property="og:title" content="イスラエル社会の右傾化と“反ネタニヤフ”の源流 | 2026-09-29 NHK総合・東京"/></head><body><script type="application/ld+json">{"partOfSeries":{"@type":"TVSeries","@id":"https://www.web.nhk/tv/an/kokusaihoudou/pl/series-tep-8M689W8RVX","name":{"@value":"国際報道 2026","@language":"ja"},"description":{"@value":"x"}}}</script></body>`;
  expect(parseLinkPreview(html, "https://www.web.nhk/tv/pl/schedule-tep-g1-130-20260929/ep/Z5PHLJECZ1")).toEqual({ creatorName: "NHK", seriesTitle: "国際報道 2026", title: "イスラエル社会の右傾化と“反ネタニヤフ”の源流" });
  // JSON-LD が読めないときは、日付と放送局を番組名にせず空にする
  const noLd = `<head><meta property="og:title" content="タイトル | 2026-09-29 NHK総合・東京"/></head>`;
  expect(parseLinkPreview(noLd, "https://www.web.nhk/tv/pl/schedule-tep-g1-130-20260929/ep/Z")).toEqual({ creatorName: "NHK", seriesTitle: "", title: "タイトル" });
});

test("NHK ONE 番組ページ(series-tep)は、JSON-LD が無くても og:title の「| 番組名」から読む", () => {
  const html = `<head><meta property="og:title" content="南米ペルー・海面水温上昇で漁業に打撃 | キャッチ!世界のトップニュース"/></head>`;
  expect(parseLinkPreview(html, "https://www.web.nhk/tv/an/catchsekai/pl/series-tep-KQ2GPZPJWM/ep/14R8MPWCE1").seriesTitle).toBe("キャッチ!世界のトップニュース");
});

test("only links of a known site are filled automatically (one.nhk share URLs included)", async () => {
  const { canAutoFill } = await import("../app/lib/link-preview.ts");
  expect(canAutoFill("https://one.nhk/www.web.nhk/tv/pl/series-tep-KQ2GPZPJWM/ep/3VQXQCV7H1")).toBe(true);
  expect(canAutoFill("https://www.web.nhk/tv/an/catchsekai/pl/series-tep-X/ep/Y")).toBe(true);
  expect(canAutoFill("https://txbiz.tv-tokyo.co.jp/wbs")).toBe(true);
  expect(canAutoFill("https://www.nhk-ondemand.jp/goods/G2025146599SA000/")).toBe(false);
});
test("the broadcaster falls back to the posted link, and every field is cut to its limit", async () => {
  const { autoFillFields } = await import("../app/lib/link-preview.ts");
  expect(autoFillFields({ creatorName: "", seriesTitle: "番組", title: "回" }, "https://one.nhk/www.web.nhk/tv/pl/x")).toEqual({ broadcaster: "NHK", programName: "番組", episodeTitle: "回" });
  expect(autoFillFields({ creatorName: "NHK", seriesTitle: "あ".repeat(300), title: "い".repeat(300) }, "https://x.test").programName).toHaveLength(200);
});
