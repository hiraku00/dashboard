import { expect, test } from "vitest";

import { summarizeRun } from "../app/lib/sync-summary.ts";

test("a run where every declared source landed is clean", () => {
  expect(summarizeRun({ declaredSourceCount: 17, snapshotCount: 17, rawStoredCount: 17 })).toEqual({
    successCount: 17,
    errorCount: 0,
    rawStoredCount: 17,
    status: "completed",
  });
});

test("missing snapshots are counted as errors, not hidden", () => {
  // The old code recorded this as success_count 15 / error_count 0.
  const summary = summarizeRun({ declaredSourceCount: 17, snapshotCount: 15, rawStoredCount: 15 });
  expect(summary.successCount).toBe(15);
  expect(summary.errorCount).toBe(2);
  expect(summary.status).toBe("completed_with_errors");
});

test("a run where nothing landed is all errors", () => {
  const summary = summarizeRun({ declaredSourceCount: 17, snapshotCount: 0, rawStoredCount: 0 });
  expect(summary.successCount).toBe(0);
  expect(summary.errorCount).toBe(17);
  expect(summary.status).toBe("completed_with_errors");
});

test("raw payloads missing from R2 are a degradation, not an error", () => {
  // Hitting the R2 soft limit stores the figures in D1 but skips the archive.
  const summary = summarizeRun({ declaredSourceCount: 17, snapshotCount: 17, rawStoredCount: 4 });
  expect(summary.errorCount).toBe(0);
  expect(summary.status).toBe("completed");
  expect(summary.rawStoredCount).toBe(4);
});

test("more snapshots than declared never yields a negative error count", () => {
  const summary = summarizeRun({ declaredSourceCount: 2, snapshotCount: 5, rawStoredCount: 5 });
  expect(summary.errorCount).toBe(0);
  expect(summary.status).toBe("completed");
});

test("missing or malformed counts degrade to zero rather than NaN", () => {
  expect(summarizeRun({ declaredSourceCount: NaN, snapshotCount: NaN, rawStoredCount: NaN })).toEqual({
    successCount: 0,
    errorCount: 0,
    rawStoredCount: 0,
    status: "completed",
  });
  const summary = summarizeRun({ declaredSourceCount: -3, snapshotCount: -1, rawStoredCount: -1 });
  expect(summary.successCount).toBe(0);
  expect(summary.errorCount).toBe(0);
});
