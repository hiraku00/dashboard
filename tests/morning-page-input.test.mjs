import { describe, expect, test } from "vitest";
import { canonicalContent, isPageDate, normalizeMorningPage } from "../app/lib/morning-page-input.ts";

const GOOD = {
  date: "2024-04-15", startedAt: "09:53", endedAt: "10:31", minutes: 38, place: "自宅", chars: 1301,
  yesterday: ["22時ごろに帰宅した", "  Perfect Days を\n観に行った  "], plan: ["洗濯物を干す"], notes: ["[気がかり] 木漏れ日のメタファー"], extracted: true,
};

describe("normalizeMorningPage", () => {
  test("accepts a full page and tidies whitespace in the lists", () => {
    const result = normalizeMorningPage(GOOD);
    expect(result.ok).toBe(true);
    expect(result.page.yesterday).toEqual(["22時ごろに帰宅した", "Perfect Days を 観に行った"]);
    expect(result.page).toMatchObject({ startedAt: "09:53", minutes: 38, place: "自宅", extracted: true });
  });

  test("a header-only page may leave everything else out", () => {
    const result = normalizeMorningPage({ date: "2026-02-03" });
    expect(result).toEqual({ ok: true, page: { date: "2026-02-03", startedAt: null, endedAt: null, minutes: null, place: "", chars: null, yesterday: [], plan: [], notes: [], extracted: false } });
  });

  test("rejects each wrong field with the date kept for the report", () => {
    const bad = (patch) => normalizeMorningPage({ ...GOOD, ...patch });
    expect(bad({ date: "2026-02-30" })).toMatchObject({ ok: false });
    expect(bad({ startedAt: "9:53" })).toMatchObject({ ok: false, date: "2024-04-15" });
    expect(bad({ endedAt: "25:00" })).toMatchObject({ ok: false });
    expect(bad({ minutes: 1413 })).toMatchObject({ ok: false });
    expect(bad({ minutes: 3.5 })).toMatchObject({ ok: false });
    expect(bad({ chars: -1 })).toMatchObject({ ok: false });
    expect(bad({ place: "あ".repeat(101) })).toMatchObject({ ok: false });
    expect(bad({ yesterday: "文字列" })).toMatchObject({ ok: false });
    expect(bad({ plan: Array(17).fill("x") })).toMatchObject({ ok: false });
    expect(bad({ notes: ["あ".repeat(401)] })).toMatchObject({ ok: false });
    expect(bad({ notes: [1] })).toMatchObject({ ok: false });
    expect(bad({ extracted: "yes" })).toMatchObject({ ok: false });
    expect(normalizeMorningPage(null)).toMatchObject({ ok: false, date: "" });
  });

  test("the content key ignores the date, so the same page content on a re-send is the same", () => {
    const a = normalizeMorningPage(GOOD).page;
    const b = normalizeMorningPage({ ...GOOD, date: "2024-04-16" }).page;
    expect(canonicalContent(a)).toBe(canonicalContent(b));
    expect(canonicalContent(a)).not.toBe(canonicalContent({ ...a, plan: [] }));
  });

  test("isPageDate checks the calendar", () => {
    expect(isPageDate("2024-02-29")).toBe(true);
    expect(isPageDate("2025-02-29")).toBe(false);
    expect(isPageDate("2025-2-1")).toBe(false);
  });
});
