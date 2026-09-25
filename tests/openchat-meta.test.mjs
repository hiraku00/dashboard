import { describe, expect, test } from "vitest";
import { MAX_BROADCASTER, MAX_LINKS, inferBroadcaster, metaFromRow, normalizeMeta, safeUrl, siteOf } from "../app/lib/openchat-meta.ts";

describe("safeUrl", () => {
  test("accepts only http(s) URLs", () => {
    expect(safeUrl("https://www.web.nhk/tv/x")).toBe("https://www.web.nhk/tv/x");
    expect(safeUrl(" http://example.test ")).toBe("http://example.test/");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://x.test", "not a url", "", null, 5]) expect(safeUrl(bad)).toBeNull();
    expect(safeUrl(`https://x.test/${"a".repeat(2100)}`)).toBeNull();
  });
});

describe("normalizeMeta", () => {
  test("trims, flattens newlines, cuts lengths and drops empty link rows", () => {
    const r = normalizeMeta({ broadcaster: `  NHK\nBS ${"あ".repeat(80)}`, episodeTitle: " 回 ", links: [{ url: "", label: "" }, { url: "https://a.test", label: " 公式 " }] });
    expect("meta" in r && r.meta).toEqual({ broadcaster: `NHK BS ${"あ".repeat(80)}`.slice(0, MAX_BROADCASTER), programName: "", episodeTitle: "回", links: [{ url: "https://a.test/", label: "公式" }] });
  });
  test("rejects a bad URL or too many links instead of silently dropping them", () => {
    expect(normalizeMeta({ links: [{ url: "javascript:1", label: "x" }] })).toHaveProperty("error");
    expect(normalizeMeta({ links: Array.from({ length: MAX_LINKS + 1 }, (_, i) => ({ url: `https://a.test/${i}` })) })).toHaveProperty("error");
    expect(normalizeMeta(null)).toHaveProperty("error");
  });
  test("everything empty is valid (clears the fields)", () => {
    expect(normalizeMeta({})).toEqual({ meta: { broadcaster: "", programName: "", episodeTitle: "", links: [] } });
  });
});

describe("metaFromRow", () => {
  test("no row or a broken row is empty; unsafe stored links are dropped", () => {
    expect(metaFromRow(undefined)).toEqual({ broadcaster: "", programName: "", episodeTitle: "", links: [] });
    expect(metaFromRow({ broadcaster: "NHK", episode_title: "x", links_json: "{broken" }).links).toEqual([]);
    expect(metaFromRow({ links_json: JSON.stringify([{ url: "javascript:1", label: "a" }, { url: "https://ok.test", label: "b" }]) }).links).toEqual([{ url: "https://ok.test/", label: "b" }]);
  });
});

describe("sites: link names and the broadcaster inferred from a link", () => {
  test("NHK ONE and WBS are recognised by host (and path for WBS)", () => {
    expect(siteOf("https://www.web.nhk/tv/pl/series-tep-XXXX")).toMatchObject({ name: "NHK ONE", broadcaster: "NHK" });
    expect(siteOf("https://txbiz.tv-tokyo.co.jp/wbs")).toMatchObject({ name: "WBS", broadcaster: "テレ東" });
    expect(siteOf("https://txbiz.tv-tokyo.co.jp/wbs/")).toMatchObject({ name: "WBS" });
    expect(siteOf("https://txbiz.tv-tokyo.co.jp/wbs/feature/1")).toMatchObject({ name: "WBS" });
    expect(siteOf("https://txbiz.tv-tokyo.co.jp/wbsx")).toBeNull();            // 前方一致で取り違えない
    expect(siteOf("https://txbiz.tv-tokyo.co.jp/other")).toBeNull();           // 同じドメインでも、別の番組は対象外
    expect(siteOf("https://example.test/")).toBeNull();
    expect(siteOf("not a url")).toBeNull();
  });
  test("the broadcaster comes from the first recognised link, or is empty", () => {
    expect(inferBroadcaster(["https://example.test/", "https://www.web.nhk/x"])).toBe("NHK");
    expect(inferBroadcaster(["https://txbiz.tv-tokyo.co.jp/wbs"])).toBe("テレ東");
    expect(inferBroadcaster(["https://example.test/"])).toBe("");
    expect(inferBroadcaster([])).toBe("");
  });
});
