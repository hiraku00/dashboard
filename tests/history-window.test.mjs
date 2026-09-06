import { expect, test } from "vitest";

// The history endpoint's ?days= cutoff has to reproduce exactly the window the
// page used to compute client-side, otherwise a chart silently loses or gains
// a day at the edge. The page's rule is in app-ui.js's assetPeriodRows():
//
//   cutoff = latest_date - (period - 1) days;  keep rows where date >= cutoff
//
// so a 7d window is seven calendar days *including* the latest, not the latest
// minus seven. This reimplements both sides of that and pins the boundary.

/** The client's filter, as written in public/manage-asset-original/app-ui.js. */
function clientWindow(dates, period) {
  if (period === "all" || !dates.length) return dates;
  const latest = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
  latest.setUTCDate(latest.getUTCDate() - Number(period) + 1);
  const cutoff = latest.toISOString().slice(0, 10);
  return dates.filter((date) => date >= cutoff);
}

/** The server's cutoff, as written in app/api/manage-asset/history/route.ts. */
function serverCutoff(latestDate, days) {
  if (!days || days === "all") return null;
  const window = Number(days);
  if (!Number.isFinite(window) || window < 1) return null;
  const date = new Date(`${latestDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - Math.trunc(window) + 1);
  return date.toISOString().slice(0, 10);
}

const days = (count, from = "2026-06-01") => {
  const start = new Date(`${from}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
};

test("the server cutoff selects exactly the client's window", () => {
  const dates = days(200);
  const latest = dates[dates.length - 1];
  for (const period of ["7", "30", "90"]) {
    const cutoff = serverCutoff(latest, period);
    const server = dates.filter((date) => date >= cutoff);
    expect(server, `period=${period}`).toEqual(clientWindow(dates, period));
    expect(server.length, `period=${period} の日数`).toBe(Number(period));
  }
});

test("a 7 day window includes the latest day, not eight days", () => {
  // Off-by-one here would show a different first point on every chart.
  expect(serverCutoff("2026-09-06", "7")).toBe("2026-08-31");
  expect(serverCutoff("2026-09-06", "1")).toBe("2026-09-06");
});

test("all, empty and malformed values mean no cutoff", () => {
  for (const value of ["all", "", "0", "-5", "abc", "NaN"]) {
    expect(serverCutoff("2026-09-06", value), `days=${value}`).toBe(null);
  }
});

test("the cutoff crosses month and year boundaries correctly", () => {
  expect(serverCutoff("2026-01-03", "7")).toBe("2025-12-28");
  expect(serverCutoff("2026-03-02", "3")).toBe("2026-02-28");
});

test("a window longer than the data keeps everything", () => {
  const dates = days(10);
  const cutoff = serverCutoff(dates[dates.length - 1], "90");
  expect(dates.filter((date) => date >= cutoff)).toEqual(dates);
});

test("the client's own filter is reproduced for the boundary day", () => {
  // The day exactly on the cutoff must be kept, the one before dropped.
  const dates = days(20);
  const latest = dates[dates.length - 1];
  const cutoff = serverCutoff(latest, "7");
  expect(dates.includes(cutoff)).toBeTruthy();
  const before = new Date(`${cutoff}T00:00:00Z`);
  before.setUTCDate(before.getUTCDate() - 1);
  const dropped = before.toISOString().slice(0, 10);
  const kept = dates.filter((date) => date >= cutoff);
  expect(kept.includes(cutoff), "境界日は含まれる").toBeTruthy();
  expect(!kept.includes(dropped), "境界日の前日は含まれない").toBeTruthy();
});
