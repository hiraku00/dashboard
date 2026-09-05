import assert from "node:assert/strict";
import test from "node:test";

import { combineAssetTotals } from "../app/lib/portal-summary.ts";

// combineAssetTotals() is the pure "which number wins" decision extracted out
// of portalSummary(): a snapshot's own total_usd/total_jpy is preferred, and
// summing that snapshot's positions is only a fallback for older rows from
// before totals were stored directly on the snapshot. Getting this backwards
// (always summing positions, or never falling back) would silently change
// the portal's headline totals without any route returning an error.

test("prefers the snapshot's own stored total over summing its positions", () => {
  const snapshots = [{ id: "s1", total_usd: 100, total_jpy: 15000 }];
  const positions = new Map([["s1", { usd: 999, jpy: 999 }]]);
  assert.deepEqual(combineAssetTotals(snapshots, positions), { usd: 100, jpy: 15000 });
});

test("falls back to the position sum when the snapshot's own total is zero", () => {
  const snapshots = [{ id: "s1", total_usd: 0, total_jpy: 0 }];
  const positions = new Map([["s1", { usd: 42, jpy: 6300 }]]);
  assert.deepEqual(combineAssetTotals(snapshots, positions), { usd: 42, jpy: 6300 });
});

test("falls back to zero when neither the snapshot nor a positions row exists", () => {
  const snapshots = [{ id: "s1", total_usd: 0, total_jpy: 0 }];
  assert.deepEqual(combineAssetTotals(snapshots, new Map()), { usd: 0, jpy: 0 });
});

test("sums across multiple sources independently", () => {
  const snapshots = [
    { id: "s1", total_usd: 100, total_jpy: 15000 },
    { id: "s2", total_usd: 0, total_jpy: 0 },
  ];
  const positions = new Map([["s2", { usd: 50, jpy: 7500 }]]);
  assert.deepEqual(combineAssetTotals(snapshots, positions), { usd: 150, jpy: 22500 });
});

test("treats a null/undefined stored total the same as zero, not as NaN", () => {
  const snapshots = [{ id: "s1", total_usd: null, total_jpy: undefined }];
  const positions = new Map([["s1", { usd: 10, jpy: 1500 }]]);
  assert.deepEqual(combineAssetTotals(snapshots, positions), { usd: 10, jpy: 1500 });
});

test("an empty snapshot list totals to zero", () => {
  assert.deepEqual(combineAssetTotals([], new Map()), { usd: 0, jpy: 0 });
});
