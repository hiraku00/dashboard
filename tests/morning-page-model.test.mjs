import { describe, expect, test } from "vitest";
import { DAILY_REPORT_START, buildMorningModel, concernsFromReflection, monthLabel } from "../app/lib/morning-page-model.ts";
import { classifyPlace } from "../app/lib/morning-page-places.ts";

const row = (date, patch = {}) => ({ date, startedAt: "08:00", endedAt: "08:40", minutes: 40, place: "自宅", chars: 2000, yesterday: [], plan: [], notes: [], extracted: false, ...patch });

const MONTHS = [
  { month: "2024-03", pages: 18, avgMinutes: 30, avgChars: 900 },
  { month: "2024-04", pages: 3, avgMinutes: 50, avgChars: 1500 },
  { month: "2026-01", pages: 10, avgMinutes: 40, avgChars: 2500 },
];

const view = (patch) => ({ months: MONTHS, monthPlaces: [], month: null, rows: [], reflections: [], notesYear: null, yearNotes: [], yearReflections: [], search: null, ...patch });

describe("buildMorningModel", () => {
  const rows = [
    row("2024-04-02", { minutes: 20, chars: 1000, notes: ["気がかりA"], yesterday: ["昨日のこと"], extracted: true }),
    row("2024-04-15", { minutes: 90, chars: null, place: "自宅（槻木）", notes: ["気がかりB", "気がかりC"], extracted: true }),
    row("2024-04-30", { minutes: null, place: "ホテル(Hi Hotel)" }),
  ];
  const model = buildMorningModel(view({ month: "2024-04", rows, monthPlaces: [{ month: "2024-04", place: "自宅", pages: 1 }, { month: "2024-04", place: "自宅（槻木）", pages: 1 }, { month: "2024-04", place: "ホテル(Hi Hotel)", pages: 1 }, { month: "2024-03", place: "7F 中庭", pages: 18 }] }));

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

  test("places are grouped by meaning (most days first, ties in the group order), with the written names kept as the breakdown", () => {
    expect(model.places).toEqual([
      { group: "home", label: "自宅", count: 1, raw: [{ place: "自宅", count: 1 }] },
      { group: "family", label: "実家", count: 1, raw: [{ place: "自宅（槻木）", count: 1 }] },
      { group: "stay", label: "宿泊先", count: 1, raw: [{ place: "ホテル(Hi Hotel)", count: 1 }] },
    ]);
    expect(model.dayBars[14]).toMatchObject({ group: "family" });
  });

  test("the trend counts every month's pages by place group", () => {
    expect(model.trend.map((t) => [t.month, t.daysInMonth, t.places.home, t.places.shared, t.places.family, t.places.stay])).toEqual([
      ["2024-03", 31, 0, 18, 0, 0],
      ["2024-04", 30, 1, 0, 1, 1],
      ["2026-01", 31, 0, 0, 0, 0],
    ]);
  });

  test("days before the daily report keep what Claude extracted", () => {
    expect(model.days.map((d) => d.source)).toEqual(["extracted", "extracted", "header"]);
  });

  test("days from the daily report start link to the report's reflection tab", () => {
    expect(DAILY_REPORT_START).toBe("2025-12-23");
    const late = buildMorningModel(view({ month: "2026-01", rows: [row("2026-01-10")] }));
    expect(late.days[0].reportLink).toBe("/daily-report?range=day&date=2026-01-10&tab=reflection");
    expect(model.days.every((d) => d.reportLink === null)).toBe(true);
  });

  test("no data at all is an empty model, not an error", () => {
    const empty = buildMorningModel(view({ months: [] }));
    expect(empty).toMatchObject({ empty: true, month: null, dayBars: [], trend: [], prev: null, next: null });
  });
});

describe("classifyPlace", () => {
  test.each([
    ["自宅", "home"],
    ["自宅(Nue District R9)", "home"],
    ["自宅(co-working - focus5)", "shared"],
    ["自宅(7F 中庭)", "shared"],
    ["7F-中庭", "shared"],
    ["7F - 中庭", "shared"],
    ["Focus 2", "shared"],
    ["36F Sky Lounge2", "shared"],
    ["R棟33Fベランダ", "shared"],
    ["Circular Lounge", "shared"],
    ["自宅（槻木）", "family"],
    ["実家", "family"],
    ["石川家", "friends"],
    ["ホテル(Hi Hotel Bangkok)", "stay"],
    ["安心お宿 新宿", "stay"],
    ["ファーストキャビン秋葉原<br>ロビー", "stay"],
    ["Cafe Amazon(トンロー駅前店)", "cafe"],
    ["ベローチェ南新宿", "cafe"],
    ["仙台空港(出発ロビー)", "transit"],
    ["バス（仙台→東京）", "transit"],
    ["", "other"],
    ["どこか", "other"],
  ])("%s → %s", (place, group) => {
    expect(classifyPlace(place)).toBe(group);
  });
});

describe("pages in the daily report period", () => {
  const markdown = (plan, concern) => `## 6. 予定と振り返り\n\n### 予定と実績\n\n| 予定 | 結果 | 状態 |\n|---|---|---|\n| ${plan} | した | 済 |\n| （予定になし）動画 | 見た | 予定外 |\n\n### PCの外の活動\n\n| 時刻 | 活動 | 種類 |\n|---|---|---|\n| — | 散歩 | 運動 |\n\n### 気になったこと・持ち越し\n\n- [持ち越し] 続きを読む\n- [気がかり] ${concern}\n`;

  test("a report's concerns belong to the next morning's page", () => {
    expect(concernsFromReflection({ reportDate: "2026-02-28", markdown: markdown("買い物", "肌荒れ") })).toEqual([{ date: "2026-03-01", text: "肌荒れ" }]);
  });

  test("header-only pages get the plan from that day's report and the rest from the day before", () => {
    const model = buildMorningModel(view({
      month: "2026-01",
      rows: [row("2026-01-10"), row("2026-01-11"), row("2026-01-20")],
      reflections: [{ reportDate: "2026-01-10", markdown: markdown("買い物", "肌荒れ") }, { reportDate: "2026-01-11", markdown: markdown("読書", "眠い") }],
    }));
    expect(model.days.map((d) => [d.date, d.plan, d.yesterday, d.notes, d.source])).toEqual([
      ["2026-01-10", ["買い物"], [], [], "report"],
      ["2026-01-11", ["読書"], ["散歩"], ["肌荒れ"], "report"],
      ["2026-01-20", [], [], [], "header"],
    ]);
  });

  test("the notes tab merges extracted page notes and report concerns for the year, newest first", () => {
    const model = buildMorningModel(view({
      month: "2026-01",
      notesYear: "2025",
      yearNotes: [{ date: "2025-03-01", notes: ["古い気がかり"] }],
      yearReflections: [{ reportDate: "2025-12-30", markdown: markdown("x", "年末") }, { reportDate: "2025-12-31", markdown: markdown("x", "翌年の朝") }],
    }));
    expect(model.concerns).toEqual([
      { date: "2025-12-31", text: "年末", source: "report" },
      { date: "2025-03-01", text: "古い気がかり", source: "page" },
    ]);
  });
});
