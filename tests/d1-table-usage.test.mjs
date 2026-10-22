import { describe, expect, test } from "vitest";
import { formatBytes, formatBytesDelta, summarizeTableUsage, usageGroupOf } from "../app/lib/d1-table-usage.ts";

const row = (usageDate, tableName, payloadBytes, rowCount = 1) => ({ usageDate, tableName, rowCount, payloadBytes });

describe("usageGroupOf", () => {
  test("puts each table under the usage page row it belongs to", () => {
    expect(["items", "item_links", "import_runs"].map(usageGroupOf)).toEqual(["watchList", "watchList", "watchList"]);
    expect(usageGroupOf("asset_snapshots")).toBe("manageAsset");
    expect(usageGroupOf("text_tube_videos")).toBe("textTube");
    expect(usageGroupOf("openchat_notes")).toBe("openchatNotes");
    expect(usageGroupOf("openchat_note_meta")).toBe("openchatNotes");
    expect(usageGroupOf("openchat_comments")).toBe("openchatComments");
    expect(usageGroupOf("todo_tasks")).toBe("todoTasks");
    expect(usageGroupOf("daily_reports")).toBe("dailyReports");
    expect(usageGroupOf("daily_report_tag_days")).toBe("dailyReports");
    expect(usageGroupOf("storage_objects")).toBe("system");
    expect(usageGroupOf("d1_table_usage_daily")).toBe("system");
  });
});

describe("summarizeTableUsage", () => {
  test("no measurement yet", () => {
    expect(summarizeTableUsage([])).toEqual({ date: null, baseDate: null, days: 0, totalBytes: 0, baseTotalBytes: null, groups: [] });
  });

  test("a single measurement has sizes but no growth", () => {
    const summary = summarizeTableUsage([row("2026-10-23", "items", 1000, 3), row("2026-10-23", "item_links", 200), row("2026-10-23", "daily_reports", 5000)]);
    expect(summary).toMatchObject({ date: "2026-10-23", baseDate: null, days: 0, totalBytes: 6200, baseTotalBytes: null });
    expect(summary.groups.map((group) => [group.key, group.bytes, group.baseBytes])).toEqual([["watchList", 1200, null], ["dailyReports", 5000, null]]);
    expect(summary.groups[0].tables).toEqual([
      { name: "items", rows: 3, bytes: 1000, baseBytes: null },
      { name: "item_links", rows: 1, bytes: 200, baseBytes: null },
    ]);
  });

  test("compares the latest day with the base day; a table new since then counts from zero", () => {
    const summary = summarizeTableUsage([
      row("2026-09-23", "items", 800),
      row("2026-10-23", "items", 1000),
      row("2026-10-23", "daily_reports", 5000),
    ]);
    expect(summary).toMatchObject({ date: "2026-10-23", baseDate: "2026-09-23", days: 30, totalBytes: 6000, baseTotalBytes: 800 });
    expect(summary.groups.map((group) => [group.key, group.bytes, group.baseBytes])).toEqual([["watchList", 1000, 800], ["dailyReports", 5000, 0]]);
  });
});

describe("formatBytes / formatBytesDelta", () => {
  test("uses B, KB and MB", () => {
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3.5 * 1024 * 1024)).toBe("3.50 MB");
    expect(formatBytesDelta(1536)).toBe("+1.5 KB");
    expect(formatBytesDelta(-2 * 1024 * 1024)).toBe("−2.00 MB");
    expect(formatBytesDelta(0.2)).toBe("±0 B");
  });
});
