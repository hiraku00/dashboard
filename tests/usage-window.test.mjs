import { expect, test } from "vitest";

import { dailyResetWindows } from "../app/lib/usage-window.ts";

test("a UTC day maps to the local windows it actually covers", () => {
  const windows = dailyResetWindows("2026-09-05");
  expect(windows).toEqual([
    { label: "日本", offsetLabel: "UTC+9", start: "9/5 09:00", end: "9/6 09:00" },
    { label: "バンコク", offsetLabel: "UTC+7", start: "9/5 07:00", end: "9/6 07:00" },
  ]);
});

test("crossing a month boundary rolls the date, not just the time", () => {
  const windows = dailyResetWindows("2026-09-30");
  expect(windows[0].start).toBe("9/30 09:00");
  expect(windows[0].end).toBe("10/1 09:00");
  expect(windows[1].start).toBe("9/30 07:00");
  expect(windows[1].end).toBe("10/1 07:00");
});

test("crossing a year boundary rolls correctly", () => {
  const windows = dailyResetWindows("2026-12-31");
  expect(windows[0].end).toBe("1/1 09:00");
  expect(windows[1].end).toBe("1/1 07:00");
});

test("neither zone observes DST, so the window is the same all year", () => {
  // Japan and Thailand have no daylight saving, so a midsummer day maps the
  // same way as a midwinter one. If this ever changes the panel would be
  // quietly wrong for half the year.
  for (const date of ["2026-01-15", "2026-07-15"]) {
    const windows = dailyResetWindows(date);
    expect(windows[0].start.endsWith("09:00"), `${date} 日本 start`).toBeTruthy();
    expect(windows[1].start.endsWith("07:00"), `${date} バンコク start`).toBeTruthy();
  }
});

test("a malformed or missing date yields no windows rather than nonsense", () => {
  expect(dailyResetWindows("")).toEqual([]);
  expect(dailyResetWindows("2026-9-5")).toEqual([]);
  expect(dailyResetWindows("not-a-date")).toEqual([]);
  expect(dailyResetWindows("2026-13-45")).toEqual([]);
});
