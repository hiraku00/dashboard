import { describe, expect, test } from "vitest";
import {
  addDays, axisRange, axisTicks, breakdown, formatClock, formatMinutes, groupDayWorkItems, groupOfTag, groupShares,
  periodRange, perDayAverages, tagLabel, timelineSegments, weekDates, weekdayIndex, weekdayLabel,
} from "../app/lib/daily-report-summary.ts";
import { DAILY_REPORT_TAGS } from "../app/lib/daily-report-tags.ts";

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

describe("tags and groups", () => {
  test("every dictionary tag lands in its own group and other is the fallback", () => {
    for (const tag of DAILY_REPORT_TAGS) expect(groupOfTag(tag.key)).toBe(tag.group);
    expect(groupOfTag("other")).toBe("other");
    expect(groupOfTag("unknown-tag")).toBe("other");
    expect(tagLabel("english")).toBe("英語学習");
    expect(tagLabel("other")).toBe("その他");
    expect(tagLabel("unknown-tag")).toBe("unknown-tag");
  });
});

describe("dates", () => {
  test("weeks start on Monday", () => {
    expect(weekdayIndex("2026-10-19")).toBe(0);
    expect(weekdayIndex("2026-10-25")).toBe(6);
    expect(weekdayLabel("2026-10-21")).toBe("水");
    expect(weekDates("2026-10-22")).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
    expect(weekDates("2026-10-25")[0]).toBe("2026-10-19");
  });

  test("addDays crosses month and year boundaries", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("periodRange", () => {
  test("a week and the one before it", () => {
    expect(periodRange("week", "2026-10-22", "2026-10-22")).toEqual({
      range: "week", from: "2026-10-19", to: "2026-10-25", prevFrom: "2026-10-12", prevTo: "2026-10-18", days: 7, elapsedDays: 4,
    });
  });

  test("a finished week counts all seven days, a future one none", () => {
    expect(periodRange("week", "2026-10-14", "2026-10-22").elapsedDays).toBe(7);
    expect(periodRange("week", "2026-11-04", "2026-10-22").elapsedDays).toBe(0);
  });

  test("a month accepts YYYY-MM or a full date, including February and the year boundary", () => {
    expect(periodRange("month", "2026-10", "2026-10-22")).toEqual({
      range: "month", from: "2026-10-01", to: "2026-10-31", prevFrom: "2026-09-01", prevTo: "2026-09-30", days: 31, elapsedDays: 22,
    });
    expect(periodRange("month", "2026-02-10", "2026-10-22")).toMatchObject({ to: "2026-02-28", days: 28, prevFrom: "2026-01-01" });
    expect(periodRange("month", "2026-01", "2026-10-22")).toMatchObject({ prevFrom: "2025-12-01", prevTo: "2025-12-31" });
  });
});

const block = (position, startMinute, endMinute, activity, tags = [], isGap = false) => ({
  position, startMinute, endMinute, activity, durationMinutes: endMinute === null || startMinute === null ? null : endMinute - startMinute, isGap, tags,
});

describe("timelineSegments", () => {
  test("splits a block evenly across its tags, paints untagged time as other, and leaves gaps without parts", () => {
    const segments = timelineSegments([
      block(0, 480, 540, "英語とdashboard", ["english", "dashboard"]),
      block(1, 540, 570, "不明な作業"),
      block(2, 570, 690, "（ログなし）", [], true),
    ]);
    expect(segments[0].parts).toEqual([
      { tag: "english", group: "study", fraction: 0.5 },
      { tag: "dashboard", group: "dev", fraction: 0.5 },
    ]);
    expect(segments[1].parts).toEqual([{ tag: "other", group: "other", fraction: 1 }]);
    expect(segments[2]).toMatchObject({ isGap: true, parts: [] });
  });

  test("skips blocks whose times could not be read or run backwards", () => {
    const segments = timelineSegments([block(0, null, null, "時刻が読めない"), block(1, 600, 600, "ゼロ"), block(2, 700, 650, "逆"), block(3, 600, 660, "正常")]);
    expect(segments.map((segment) => segment.position)).toEqual([3]);
  });
});

describe("axisRange / axisTicks", () => {
  test("rounds outwards to whole hours and falls back to 8–22 with no blocks", () => {
    expect(axisRange([{ startMinute: 486, endMinute: 540 }, { startMinute: 1300, endMinute: 1354 }])).toEqual({ startHour: 8, endHour: 23 });
    expect(axisRange([])).toEqual({ startHour: 8, endHour: 22 });
    expect(axisRange([{ startMinute: 600, endMinute: 600 }])).toEqual({ startHour: 10, endHour: 11 });
  });

  test("ticks every hour on a short axis and every two hours on a long one", () => {
    expect(axisTicks({ startHour: 9, endHour: 15 })).toEqual([9, 10, 11, 12, 13, 14, 15]);
    expect(axisTicks({ startHour: 7, endHour: 24 })).toEqual([8, 10, 12, 14, 16, 18, 20, 22, 24]);
  });
});

describe("breakdown", () => {
  const current = { english: 90, electronics: 30, dashboard: 120, media: 0, other: 20, communication: 54 };

  test("orders groups and tags by minutes, drops zero tags, and puts other last", () => {
    const groups = breakdown(current, null);
    expect(groups.map((entry) => entry.group)).toEqual(["study", "dev", "life", "other"]);
    expect(groups[0]).toMatchObject({ minutes: 120, baselineMinutes: null });
    expect(groups[0].tags.map((tag) => tag.tag)).toEqual(["english", "electronics"]);
    expect(groups.at(-1).tags[0]).toMatchObject({ tag: "other", label: "その他", minutes: 20 });
  });

  test("carries the baseline per tag and per group; tags only in the baseline are not shown", () => {
    const groups = breakdown({ english: 90, dashboard: 120 }, { english: 60, electronics: 45, dashboard: 150 });
    const study = groups.find((entry) => entry.group === "study");
    expect(study.baselineMinutes).toBe(60);
    expect(study.tags).toEqual([{ tag: "english", label: "英語学習", minutes: 90, baselineMinutes: 60 }]);
    expect(groups.find((entry) => entry.group === "dev").baselineMinutes).toBe(150);
  });

  test("a tag with no baseline entry counts as zero against a present baseline", () => {
    const groups = breakdown({ english: 90 }, { dashboard: 30 });
    expect(groups[0].tags[0].baselineMinutes).toBe(0);
  });
});

describe("perDayAverages", () => {
  test("averages over the days that have a report, not over calendar days", () => {
    const result = perDayAverages([
      { reportDate: "2026-10-19", tag: "english", minutes: 120 },
      { reportDate: "2026-10-19", tag: "media", minutes: 60 },
      { reportDate: "2026-10-21", tag: "english", minutes: 60 },
    ]);
    expect(result).toEqual({ days: 2, minutes: { english: 90, media: 30 } });
  });

  test("returns null when there is no report", () => {
    expect(perDayAverages([])).toBeNull();
  });
});

describe("groupShares", () => {
  test("percentages are of the active time and add up to 100", () => {
    const shares = groupShares(breakdown({ english: 60, dashboard: 30, other: 10 }, null));
    expect(shares.map((share) => share.percent)).toEqual([60, 30, 10]);
    expect(groupShares([])).toEqual([]);
  });
});

describe("groupDayWorkItems", () => {
  test("groups by heading in report order", () => {
    const groups = groupDayWorkItems([
      { position: 2, categoryPosition: 1, category: "ダッシュボード", itemPosition: 0, text: "c", tags: ["dashboard"] },
      { position: 0, categoryPosition: 0, category: "英語", itemPosition: 0, text: "a", tags: ["english"] },
      { position: 1, categoryPosition: 0, category: "英語", itemPosition: 1, text: "b", tags: [] },
    ]);
    expect(groups.map((group) => [group.category, group.items.map((entry) => entry.text)])).toEqual([["英語", ["a", "b"]], ["ダッシュボード", ["c"]]]);
  });
});
