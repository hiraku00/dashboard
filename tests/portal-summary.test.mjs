import { expect, test } from "vitest";

import { assetTotals } from "../app/lib/portal-summary.ts";

// assetTotals() is the home page's "total assets", and it deliberately uses the
// same definition as Manage Asset's overview: USD is the sum of each source's
// stored total (a stored 0 stays 0), JPY is that USD total times ONE rate -- the
// newest snapshot's fx_usdjpy. Two screens showing two different "total assets"
// (a few cents in USD, ~10,000 yen in JPY on production) is what this replaced.

const wallet = (over = {}) => ({ id: "w", source_id: "w", display_name: "W", source_type: "wallet", captured_at: "2026-09-10T02:00:00Z", as_of_date: "2026-09-10", fx_usdjpy: 150, total_usd: 100, total_jpy: 15000, ...over });
const exchange = (over = {}) => wallet({ id: "x", source_id: "x", display_name: "X", source_type: "exchange", ...over });

test("USD is the sum of every source's stored total, wallets and exchanges alike", () => {
  expect(assetTotals([wallet({ total_usd: 100 }), exchange({ total_usd: 250.5 })]).usd).toBe(350.5);
});

test("a stored total of 0 counts as 0 -- it is not replaced by anything", () => {
  // DeBank stores a tiny wallet as $0 (integer rounding); Manage Asset shows 0 for it, so the home page must too.
  expect(assetTotals([wallet({ source_id: "a", total_usd: 200 }), wallet({ source_id: "b", total_usd: 0, total_jpy: 0 })]).usd).toBe(200);
});

test("JPY is the USD total times the newest snapshot's rate, not the sum of each snapshot's own JPY", () => {
  const totals = assetTotals([
    wallet({ source_id: "a", total_usd: 1000, total_jpy: 150000, fx_usdjpy: 150, captured_at: "2026-09-10T02:00:00Z" }),
    wallet({ source_id: "b", total_usd: 1000, total_jpy: 152000, fx_usdjpy: 152, captured_at: "2026-09-10T03:00:00Z" }), // newest -> the rate
  ]);
  expect(totals.usd).toBe(2000);
  expect(totals.jpy).toBe(2000 * 152); // 304,000, where summing the stored JPY would give 302,000
});

test("rows with no rate do not take part in choosing it", () => {
  const totals = assetTotals([
    wallet({ source_id: "a", total_usd: 100, fx_usdjpy: 150, captured_at: "2026-09-10T02:00:00Z" }),
    wallet({ source_id: "b", total_usd: 100, fx_usdjpy: null, captured_at: "2026-09-10T09:00:00Z" }), // newer, but no rate
    wallet({ source_id: "c", total_usd: 100, fx_usdjpy: 0, captured_at: "2026-09-10T10:00:00Z" }), // a zero rate is no rate
  ]);
  expect(totals.jpy).toBe(300 * 150);
});

test("with no rate on any snapshot, JPY falls back to the sum of the stored JPY", () => {
  const totals = assetTotals([wallet({ source_id: "a", fx_usdjpy: null, total_usd: 100, total_jpy: 15000 }), exchange({ fx_usdjpy: null, total_usd: 10, total_jpy: 1500 })]);
  expect(totals).toEqual({ usd: 110, jpy: 16500 });
});

test("a null or missing stored total is 0, not NaN", () => {
  const totals = assetTotals([wallet({ total_usd: null, total_jpy: undefined, fx_usdjpy: null })]);
  expect(totals).toEqual({ usd: 0, jpy: 0 });
});

test("an empty list totals to zero", () => {
  expect(assetTotals([])).toEqual({ usd: 0, jpy: 0 });
});

test("a source_type other than wallet is read as an exchange (its total comes from the same stored total)", () => {
  expect(assetTotals([exchange({ source_type: "Exchange", total_usd: 40 }), wallet({ source_type: "WALLET", total_usd: 60 })]).usd).toBe(100);
});
