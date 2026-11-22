import { describe, expect, test } from "vitest";
import { DAILY_REPORT_START, buildMorningModel, monthLabel, placeGroup } from "../app/lib/morning-page-model.ts";

const row = (date, patch = {}) => ({ date, startedAt: "08:00", endedAt: "08:40", minutes: 40, place: "自宅", chars: 2000, yesterday: [], plan: [], notes: [], extracted: false, ...patch });

const MONTHS = [
  { month: "2024-03", pages: 18, avgMinutes: 30, avgChars: 900 },
  { month: "2024-04", pages: 3, avgMinutes: 50, avgChars: 1500 },
  { month: "2026-01", pages: 10, avgMinutes: 40, avgChars: 2500 },
];

describe("buildMorningModel", () => {
  const rows = [
    row("2024-04-02", { minutes: 20, chars: 1000, notes: ["気がかりA"], yesterday: ["昨日のこと"], extracted: true }),
    row("2024-04-15", { minutes: 90, chars: null, place: "自宅（槻木）", notes: ["気がかりB", "気がかりC"], extracted: true }),
    row("2024-04-30", { minutes: null, place: "ホテル(Hi Hotel)" }),
  ];
  const model = buildMorningModel({ months: MONTHS, month: "2024-04", rows, search: null });

  test("month navigation only visits months that have pages, grouped by year", () => {
    expect(model.monthLabel).toBe("2024年4月");
    expect(model.prev).toBe("2024-03");
    expect(model.next).toBe("2026-01");
    expect(model.years.map((y) => [y.year, y.months.map((m) => m.label)])).toEqual([["2024", ["3月", "4月"]], ["2026", ["1月"]]]);
    expect(monthLabel("2026-01")).toBe("2026年1月");
  });

  test("stats average only what is known and mark the longest day", () => {
    expect(model.stats).toEqual({ daysInMonth: 30, pages: 3, avgMinutes: 55, avgChars: 1500, longest: { date: "2024-04-15", minutes: 90 } });
    expect(model.maxMinutes).toBe(90);
  });

  test("every day of the month has a bar, written or not", () => {
    expect(model.dayBars).toHaveLength(30);
    expect(model.dayBars[1]).toMatchObject({ date: "2024-04-02", written: true, minutes: 20 });
    expect(model.dayBars[2]).toMatchObject({ date: "2024-04-03", written: false, minutes: null });
    expect(model.dayBars[29]).toMatchObject({ written: true, minutes: null });
  });

  test("places are grouped by the part before the parenthesis", () => {
    expect(placeGroup("自宅(co-working - focus5)")).toBe("自宅");
    expect(placeGroup("ホテル（KITZIO）")).toBe("ホテル");
    expect(placeGroup("")).toBe("不明");
    expect(model.places).toEqual([{ place: "自宅", count: 2 }, { place: "ホテル", count: 1 }]);
  });

  test("notes come newest day first and extracted days are counted", () => {
    expect(model.notes).toEqual([{ date: "2024-04-15", text: "気がかりB" }, { date: "2024-04-15", text: "気がかりC" }, { date: "2024-04-02", text: "気がかりA" }]);
    expect(model.extractedDays).toBe(2);
  });

  test("days from the daily report start link to the report's reflection tab", () => {
    expect(DAILY_REPORT_START).toBe("2025-12-23");
    const late = buildMorningModel({ months: MONTHS, month: "2026-01", rows: [row("2026-01-10")], search: null });
    expect(late.days[0].reportLink).toBe("/daily-report?range=day&date=2026-01-10&tab=reflection");
    expect(model.days.every((d) => d.reportLink === null)).toBe(true);
  });

  test("no data at all is an empty model, not an error", () => {
    const empty = buildMorningModel({ months: [], month: null, rows: [], search: null });
    expect(empty).toMatchObject({ empty: true, month: null, dayBars: [], trend: [], prev: null, next: null });
  });
});
