import { expect, test } from "vitest";

import { historyMissesCutover } from "../app/lib/manage-asset-chart.ts";
import { stethRewardHistory } from "../app/lib/manage-asset-core.ts";

// stETH's chart joins the Lido CSV (last day 2026-07-14) to snapshots from the
// migration boundary (2026-07-12). A history window that starts later than the
// boundary leaves a gap the chart shows as one day's reward. These tests pin (1)
// that the gap really produces a spike, so the guard has a reason to exist, and
// (2) when the guard decides more history is needed.

const CUTOVER = "2026-07-12";
const rewardRow = (date, balance) => ({ date, type: "reward", change: 0.001, change_USD: 3, balance, apr: 2.5 });
const walletDay = (date, balance) => ({ wallet_id: "lido", wallet_name: "Lido2", as_of_date: date, captured_at: `${date}T02:00:00Z`, total_usd: balance * 3000, tokens: [{ symbol: "stETH", amount_value: balance, usd_value: balance * 3000 }] });

/** One snapshot per day from `from` to 2026-09-21; the balance grows 0.0074 a day. */
function snapshots(from) {
  const rows = [];
  let balance = 120;
  for (let d = new Date("2026-07-15T00:00:00Z"); d <= new Date("2026-09-21T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
    balance += 0.0074;
    const date = d.toISOString().slice(0, 10);
    if (date >= from) rows.push(walletDay(date, balance));
  }
  return rows;
}
const csv = [rewardRow("2026-07-13", 119.99), rewardRow("2026-07-14", 120)];

test("a window that starts after the boundary makes the first snapshot day carry the whole gap", () => {
  const complete = stethRewardHistory(csv, snapshots("2026-07-15"), [], [], CUTOVER);
  const truncated = stethRewardHistory(csv, snapshots("2026-08-20"), [], [], CUTOVER);
  const firstSnapshot = (rows) => rows.find((row) => row.source === "snapshot");
  expect(Math.abs(firstSnapshot(complete).change)).toBeLessThan(0.01); // an ordinary day
  expect(firstSnapshot(truncated).date).toBe("2026-08-20");
  expect(firstSnapshot(truncated).change).toBeGreaterThan(0.2); // ~36 days of growth booked on one day
});

test("history that already starts on or before the boundary needs nothing more", () => {
  const history = { snapshots: [walletDay("2026-07-11", 1), walletDay("2026-09-21", 2)], exchange_snapshots: [] };
  expect(historyMissesCutover(history, 90, CUTOVER)).toBe(false);
  expect(historyMissesCutover({ snapshots: [walletDay(CUTOVER, 1)], exchange_snapshots: [] }, 90, CUTOVER)).toBe(false); // exactly the boundary
});

test("history that starts after the boundary, from a limited window, needs the full history", () => {
  const history = { snapshots: [walletDay("2026-08-20", 1), walletDay("2026-09-21", 2)], exchange_snapshots: [] };
  expect(historyMissesCutover(history, 90, CUTOVER)).toBe(true);
  expect(historyMissesCutover(history, 30, CUTOVER)).toBe(true);
});

test("the full history is never short of it, however late its first row is", () => {
  const history = { snapshots: [walletDay("2026-08-20", 1)], exchange_snapshots: [] };
  expect(historyMissesCutover(history, Infinity, CUTOVER)).toBe(false);
});

test("the oldest row may be in either list", () => {
  const history = { snapshots: [walletDay("2026-09-01", 1)], exchange_snapshots: [{ source_id: "x", as_of_date: "2026-07-11" }] };
  expect(historyMissesCutover(history, 90, CUTOVER)).toBe(false);
});

test("nothing loaded, or no rows, is not 'short'", () => {
  expect(historyMissesCutover(null, 90, CUTOVER)).toBe(false);
  expect(historyMissesCutover({ snapshots: [], exchange_snapshots: [] }, 90, CUTOVER)).toBe(false);
});

test("timestamps in as_of_date are compared by their date part", () => {
  const history = { snapshots: [{ as_of_date: "2026-07-12T00:00:00.000Z" }], exchange_snapshots: [] };
  expect(historyMissesCutover(history, 90, CUTOVER)).toBe(false);
});
