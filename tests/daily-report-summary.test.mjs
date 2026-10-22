import { describe, expect, test } from "vitest";
import {
  addDays, addMonths, appSummaries, axisRange, axisTicks, breakdown, categoryOfTag, categoryShares, dailyColumns, defaultAnchor,
  formatClock, formatMinutes, groupDayWorkItems, headingSummaries, hourProfile, lastReportIn, periodRange, perDayAverages,
  shiftAnchor, switchRange, tagLabel, timelineSegments, trendSeries, weekDates, weekdayAverages, weekdayIndex, weekdayLabel,
} from "../app/lib/daily-report-summary.ts";
import { DAILY_REPORT_TAGS } from "../app/lib/daily-report-tags.ts";

const TODAY = "2026-10-22";

describe("formatMinutes / formatClock", () => {
  test("uses the 10h33m form everywhere", () => {
    expect(formatMinutes(633)).toBe("10h33m");
    expect(formatMinutes(124)).toBe("2h04m");
    expect(formatMinutes(60)).toBe("1h00m");
    expect(formatMinutes(54)).toBe("54m");
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(59.6)).toBe("1h00m");
    expect(formatMinutes(-5)).toBe("0m");
  });

  test("turns minutes since midnight into HH:MM", () => {
    expect(formatClock(486)).toBe("08:06");
    expect(formatClock(1354)).toBe("22:34");
    expect(formatClock(1500)).toBe("01:00");
  });
});

describe("categories", () => {
  test("folds the tag groups into four categories, with money under life", () => {
    const expected = { study: "study", dev: "dev", money: "life", life: "life", media: "media" };
    for (const tag of DAILY_REPORT_TAGS) expect(categoryOfTag(tag.key)).toBe(expected[tag.group]);
    expect(categoryOfTag("other")).toBe("other");
    expect(categoryOfTag("unknown-tag")).toBe("other");
    expect(tagLabel("english")).toBe("英語学習");
    expect(tagLabel("other")).toBe("未分類");
  });
});

describe("dates", () => {
  test("weeks start on Monday", () => {
    expect(weekdayIndex("2026-10-19")).toBe(0);
    expect(weekdayIndex("2026-10-25")).toBe(6);
    expect(weekdayLabel("2026-10-21")).toBe("水");
    expect(weekDates("2026-10-22")[0]).toBe("2026-10-19");
  });

  test("addDays / addMonths cross month and year boundaries", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-01");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-01");
  });
});

describe("periodRange", () => {
  test("day: the day itself, compared with the 28 days before it", () => {
    expect(periodRange("day", "2026-10-21", TODAY)).toEqual({
      range: "day", anchor: "2026-10-21", from: "2026-10-21", to: "2026-10-21", prevFrom: "2026-09-23", prevTo: "2026-10-20", trendFrom: "2026-09-23", days: 1, elapsedDays: 1,
    });
  });

  test("week: Monday to Sunday, the week before, and 12 weeks of trend", () => {
    expect(periodRange("week", "2026-10-22", TODAY)).toEqual({
      range: "week", anchor: "2026-10-19", from: "2026-10-19", to: "2026-10-25", prevFrom: "2026-10-12", prevTo: "2026-10-18", trendFrom: "2026-08-03", days: 7, elapsedDays: 4,
    });
    expect(periodRange("week", "2026-11-04", TODAY).elapsedDays).toBe(0);
  });

  test("month: the calendar month, the month before, and 12 months of trend", () => {
    expect(periodRange("month", "2026-10-05", TODAY)).toEqual({
      range: "month", anchor: "2026-10-01", from: "2026-10-01", to: "2026-10-31", prevFrom: "2026-09-01", prevTo: "2026-09-30", trendFrom: "2025-11-01", days: 31, elapsedDays: 22,
    });
    expect(periodRange("month", "2026-02-10", TODAY)).toMatchObject({ to: "2026-02-28", days: 28 });
    expect(periodRange("month", "2026-01-10", TODAY)).toMatchObject({ prevFrom: "2025-12-01", prevTo: "2025-12-31" });
  });
});

const REPORTS = ["2026-09-28", "2026-10-01", "2026-10-15", "2026-10-19", "2026-10-21"];

describe("defaultAnchor / switchRange / shiftAnchor", () => {
  test("opens the current period when it has a report, else the latest report's period", () => {
    expect(defaultAnchor("week", REPORTS, TODAY)).toBe("2026-10-19");
    expect(defaultAnchor("week", REPORTS, "2026-11-10")).toBe("2026-10-19");
    expect(defaultAnchor("day", REPORTS, TODAY)).toBe("2026-10-21");
    expect(defaultAnchor("month", REPORTS, TODAY)).toBe("2026-10-01");
    expect(defaultAnchor("week", [], TODAY)).toBe("2026-10-19");
  });

  test("going down to a day lands on the period's last report", () => {
    expect(lastReportIn(REPORTS, "2026-10-12", "2026-10-18")).toBe("2026-10-15");
    expect(switchRange(periodRange("week", "2026-10-19", TODAY), "day", REPORTS, TODAY)).toBe("2026-10-21");
    expect(switchRange(periodRange("month", "2026-09-01", TODAY), "day", REPORTS, TODAY)).toBe("2026-09-28");
    // 日報の無い週から日次へ降りると、それより前の最後の日報
    expect(switchRange(periodRange("week", "2026-10-05", TODAY), "day", REPORTS, TODAY)).toBe("2026-10-01");
    expect(switchRange(periodRange("day", "2026-10-15", TODAY), "week", REPORTS, TODAY)).toBe("2026-10-12");
    expect(switchRange(periodRange("week", "2026-09-28", TODAY), "month", REPORTS, TODAY)).toBe("2026-09-01");
  });

  test("days step between reports, skipping days without one", () => {
    const day = periodRange("day", "2026-10-15", TODAY);
    expect(shiftAnchor(day, -1, REPORTS, TODAY)).toBe("2026-10-01");
    expect(shiftAnchor(day, 1, REPORTS, TODAY)).toBe("2026-10-19");
    expect(shiftAnchor(periodRange("day", "2026-10-21", TODAY), 1, REPORTS, TODAY)).toBeNull();
  });

  test("weeks and months step one at a time, but not before the first report or past today", () => {
    expect(shiftAnchor(periodRange("week", "2026-10-12", TODAY), -1, REPORTS, TODAY)).toBe("2026-10-05");
    expect(shiftAnchor(periodRange("week", "2026-09-28", TODAY), -1, REPORTS, TODAY)).toBeNull();
    expect(shiftAnchor(periodRange("week", "2026-10-19", TODAY), 1, REPORTS, TODAY)).toBeNull();
    expect(shiftAnchor(periodRange("month", "2026-10-01", TODAY), -1, REPORTS, TODAY)).toBe("2026-09-01");
    expect(shiftAnchor(periodRange("month", "2026-09-01", TODAY), -1, REPORTS, TODAY)).toBeNull();
  });
});

const block = (position, startMinute, endMinute, activity, tags = [], isGap = false) => ({
  position, startMinute, endMinute, activity, durationMinutes: endMinute === null || startMinute === null ? null : endMinute - startMinute, isGap, tags,
});

describe("timelineSegments / axis", () => {
  test("splits a block evenly across its tags, paints untagged time as other, and leaves gaps without parts", () => {
    const segments = timelineSegments([
      block(0, 480, 540, "英語とdashboard", ["english", "dashboard"]),
      block(1, 540, 570, "不明な作業"),
      block(2, 570, 690, "（ログなし）", [], true),
      block(3, null, null, "時刻が読めない"),
      block(4, 700, 650, "逆"),
    ]);
    expect(segments.map((segment) => segment.position)).toEqual([0, 1, 2]);
    expect(segments[0].parts).toEqual([
      { tag: "english", category: "study", fraction: 0.5 },
      { tag: "dashboard", category: "dev", fraction: 0.5 },
    ]);
    expect(segments[1].parts).toEqual([{ tag: "other", category: "other", fraction: 1 }]);
    expect(segments[2]).toMatchObject({ isGap: true, parts: [] });
  });

  test("rounds the axis outwards to whole hours and ticks every one or two hours", () => {
    expect(axisRange([{ startMinute: 486, endMinute: 540 }, { startMinute: 1300, endMinute: 1354 }])).toEqual({ startHour: 8, endHour: 23 });
    expect(axisRange([])).toEqual({ startHour: 8, endHour: 22 });
    expect(axisTicks({ startHour: 9, endHour: 15 })).toEqual([9, 10, 11, 12, 13, 14, 15]);
    expect(axisTicks({ startHour: 7, endHour: 24 })).toEqual([8, 10, 12, 14, 16, 18, 20, 22, 24]);
  });
});

describe("hourProfile", () => {
  test("spreads each block over the hours it overlaps and averages over the days", () => {
    const day1 = timelineSegments([block(0, 510, 570, "英語", ["english"]), block(1, 570, 600, "ログなし", [], true)]);
    const day2 = timelineSegments([block(0, 540, 600, "YouTube", ["media"])]);
    const profile = hourProfile([day1, day2], { startHour: 8, endHour: 10 });
    expect(profile).toEqual([
      { hour: 8, minutes: { study: 15 }, daysWithRecord: 1 },
      { hour: 9, minutes: { study: 15, media: 30 }, daysWithRecord: 2 },
    ]);
  });
});

const tagRows = [
  { reportDate: "2026-10-19", tag: "english", minutes: 120 },
  { reportDate: "2026-10-19", tag: "money", minutes: 30 },
  { reportDate: "2026-10-21", tag: "english", minutes: 60 },
  { reportDate: "2026-10-21", tag: "media", minutes: 90 },
];

describe("breakdown / shares / averages", () => {
  test("orders categories and tags by minutes, drops zero tags, and puts other last", () => {
    const groups = breakdown({ english: 90, electronics: 30, dashboard: 120, media: 0, other: 20, communication: 54, money: 6 }, null);
    expect(groups.map((entry) => entry.category)).toEqual(["study", "dev", "life", "other"]);
    expect(groups[0]).toMatchObject({ minutes: 120, baselineMinutes: null });
    expect(groups[2].tags.map((tag) => tag.tag)).toEqual(["communication", "money"]);
  });

  test("the category tick counts every baseline tag of that category, the tag tick only its own", () => {
    const groups = breakdown({ english: 90, dashboard: 120 }, { english: 60, electronics: 45, dashboard: 150, media: 10 });
    const study = groups.find((entry) => entry.category === "study");
    expect(study.baselineMinutes).toBe(105);
    expect(study.tags).toEqual([{ tag: "english", label: "英語学習", minutes: 90, baselineMinutes: 60 }]);
    expect(groups.find((entry) => entry.category === "dev").baselineMinutes).toBe(150);
  });

  test("averages over the days that have a report", () => {
    expect(perDayAverages(tagRows)).toEqual({ days: 2, minutes: { english: 90, money: 15, media: 45 } });
    expect(perDayAverages(tagRows, 3).minutes.english).toBe(60);
    expect(perDayAverages([])).toBeNull();
  });

  test("shares come in the fixed category order and add up to 100", () => {
    const shares = categoryShares({ media: 30, english: 60, other: 10 });
    expect(shares.map((share) => [share.category, share.percent])).toEqual([["study", 60], ["media", 30], ["other", 10]]);
  });
});

describe("dailyColumns / weekdayAverages / trendSeries", () => {
  test("stacks each day by category and leaves days without a report empty", () => {
    const columns = dailyColumns(["2026-10-19", "2026-10-20", "2026-10-21"], tagRows, new Set(["2026-10-19", "2026-10-21"]));
    expect(columns[0]).toEqual({ date: "2026-10-19", hasReport: true, total: 150, parts: [{ category: "study", minutes: 120 }, { category: "life", minutes: 30 }] });
    expect(columns[1]).toEqual({ date: "2026-10-20", hasReport: false, total: 0, parts: [] });
    const weekdays = weekdayAverages(columns);
    expect(weekdays[0]).toEqual({ weekday: "月", minutes: 150, days: 1 });
    expect(weekdays[1]).toEqual({ weekday: "火", minutes: null, days: 0 });
  });

  test("gives 12 points of per-day averages, null for periods without a report", () => {
    const points = trendSeries(periodRange("week", "2026-10-19", TODAY), tagRows, ["2026-10-19", "2026-10-21"]);
    expect(points).toHaveLength(12);
    expect(points.at(-1)).toEqual({ from: "2026-10-19", to: "2026-10-25", label: "10/19", days: 2, minutes: { study: 90, life: 15, media: 45 } });
    expect(points[0]).toMatchObject({ from: "2026-08-03", minutes: null, days: 0 });
    expect(trendSeries(periodRange("day", "2026-10-21", TODAY), tagRows, [])).toEqual([]);
  });
});

const item = (reportDate, position, categoryPosition, category, text, tags = []) => ({ reportDate, position, categoryPosition, category, itemPosition: position, text, tags });

describe("work items and apps", () => {
  test("groups one day's items by heading in report order", () => {
    const groups = groupDayWorkItems([item("d", 2, 1, "ダッシュボード", "c"), item("d", 0, 0, "英語", "a"), item("d", 1, 0, "英語", "b")]);
    expect(groups.map((group) => [group.category, group.items.map((entry) => entry.text)])).toEqual([["英語", ["a", "b"]], ["ダッシュボード", ["c"]]]);
  });

  test("summarises headings across days, ordered by main category then first date", () => {
    const summaries = headingSummaries([
      item("2026-10-20", 0, 0, "動画視聴", "YouTube", ["media"]),
      item("2026-10-19", 0, 0, "英語学習", "Anki", ["english"]),
      item("2026-10-21", 0, 0, "英語学習", "Gemini", ["english"]),
      item("2026-10-21", 1, 1, "雑務", "整理"),
    ]);
    expect(summaries.map((entry) => [entry.heading, entry.category, entry.dates, entry.firstText])).toEqual([
      ["英語学習", "study", ["2026-10-19", "2026-10-21"], "Anki"],
      ["動画視聴", "media", ["2026-10-20"], "YouTube"],
      ["雑務", "other", ["2026-10-21"], "整理"],
    ]);
  });

  test("ranks apps by the number of days used, named by their most common name", () => {
    const app = (reportDate, appName, appKey) => ({ reportDate, appName, appKey, usageCount: null, usageCountRaw: "", usageIsMin: false, purpose: "" });
    const summaries = appSummaries([app("a", "Brave", "brave"), app("b", "Brave", "brave"), app("a", "Gemini／Anki", "gemini"), app("b", "Gemini", "gemini"), app("c", "Gemini", "gemini"), app("a", "X", "x")]);
    expect(summaries.map((entry) => [entry.name, entry.dates.length])).toEqual([["Gemini", 3], ["Brave", 2], ["X", 1]]);
  });
});
