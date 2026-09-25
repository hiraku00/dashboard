import { describe, expect, test } from "vitest";
import { MAX_BROADCASTER, MAX_LINKS, metaFromRow, normalizeMeta, safeUrl } from "../app/lib/openchat-meta.ts";

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
    expect("meta" in r && r.meta).toEqual({ broadcaster: `NHK BS ${"あ".repeat(80)}`.slice(0, MAX_BROADCASTER), episodeTitle: "回", links: [{ url: "https://a.test/", label: "公式" }] });
  });
  test("rejects a bad URL or too many links instead of silently dropping them", () => {
    expect(normalizeMeta({ links: [{ url: "javascript:1", label: "x" }] })).toHaveProperty("error");
    expect(normalizeMeta({ links: Array.from({ length: MAX_LINKS + 1 }, (_, i) => ({ url: `https://a.test/${i}` })) })).toHaveProperty("error");
    expect(normalizeMeta(null)).toHaveProperty("error");
  });
  test("everything empty is valid (clears the fields)", () => {
    expect(normalizeMeta({})).toEqual({ meta: { broadcaster: "", episodeTitle: "", links: [] } });
  });
});

describe("metaFromRow", () => {
  test("no row or a broken row is empty; unsafe stored links are dropped", () => {
    expect(metaFromRow(undefined)).toEqual({ broadcaster: "", episodeTitle: "", links: [] });
    expect(metaFromRow({ broadcaster: "NHK", episode_title: "x", links_json: "{broken" }).links).toEqual([]);
    expect(metaFromRow({ links_json: JSON.stringify([{ url: "javascript:1", label: "a" }, { url: "https://ok.test", label: "b" }]) }).links).toEqual([{ url: "https://ok.test/", label: "b" }]);
  });
});
