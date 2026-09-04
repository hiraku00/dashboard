import assert from "node:assert/strict";
import test from "node:test";

import { summarizeRun } from "../app/lib/sync-summary.ts";

test("a run where every declared source landed is clean", () => {
  assert.deepEqual(summarizeRun({ declaredSourceCount: 17, snapshotCount: 17, rawStoredCount: 17 }), {
    successCount: 17,
    errorCount: 0,
    rawStoredCount: 17,
    status: "completed",
  });
});

test("missing snapshots are counted as errors, not hidden", () => {
  // The old code recorded this as success_count 15 / error_count 0.
  const summary = summarizeRun({ declaredSourceCount: 17, snapshotCount: 15, rawStoredCount: 15 });
  assert.equal(summary.successCount, 15);
  assert.equal(summary.errorCount, 2);
  assert.equal(summary.status, "completed_with_errors");
});

test("a run where nothing landed is all errors", () => {
  const summary = summarizeRun({ declaredSourceCount: 17, snapshotCount: 0, rawStoredCount: 0 });
  assert.equal(summary.successCount, 0);
  assert.equal(summary.errorCount, 17);
  assert.equal(summary.status, "completed_with_errors");
});

test("raw payloads missing from R2 are a degradation, not an error", () => {
  // Hitting the R2 soft limit stores the figures in D1 but skips the archive.
  const summary = summarizeRun({ declaredSourceCount: 17, snapshotCount: 17, rawStoredCount: 4 });
  assert.equal(summary.errorCount, 0);
  assert.equal(summary.status, "completed");
  assert.equal(summary.rawStoredCount, 4);
});

test("more snapshots than declared never yields a negative error count", () => {
  const summary = summarizeRun({ declaredSourceCount: 2, snapshotCount: 5, rawStoredCount: 5 });
  assert.equal(summary.errorCount, 0);
  assert.equal(summary.status, "completed");
});

test("missing or malformed counts degrade to zero rather than NaN", () => {
  assert.deepEqual(summarizeRun({ declaredSourceCount: NaN, snapshotCount: NaN, rawStoredCount: NaN }), {
    successCount: 0,
    errorCount: 0,
    rawStoredCount: 0,
    status: "completed",
  });
  const summary = summarizeRun({ declaredSourceCount: -3, snapshotCount: -1, rawStoredCount: -1 });
  assert.equal(summary.successCount, 0);
  assert.equal(summary.errorCount, 0);
});
