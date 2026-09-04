/** Works out what a Manage Asset sync run actually achieved, from the number
 *  of sources the collector said it would send and the snapshots that landed.
 *
 *  The "complete" action used to write success_count = the snapshot total and
 *  error_count = a hardcoded 0, so a run where some sources failed was
 *  recorded as a clean success. The batch endpoint reports per-source failures
 *  and the collector does raise on them, but the run row -- the only record
 *  that survives the run -- said nothing went wrong. */

export type RunSummary = {
  /** Sources that wrote a snapshot. */
  successCount: number;
  /** Sources the collector declared but that never produced a snapshot. */
  errorCount: number;
  /** Of the successes, how many also stored their raw payload in R2. A
   *  shortfall means the R2 soft limit was hit: the figures are in D1, only
   *  the raw archive is missing, so it is a degradation and not an error. */
  rawStoredCount: number;
  status: "completed" | "completed_with_errors";
};

export function summarizeRun(input: {
  declaredSourceCount: number;
  snapshotCount: number;
  rawStoredCount: number;
}): RunSummary {
  const successCount = Math.max(0, Math.trunc(input.snapshotCount) || 0);
  const declared = Math.max(0, Math.trunc(input.declaredSourceCount) || 0);
  // A collector that under-declares (or a re-sent source) must not produce a
  // negative error count, so clamp rather than trusting the subtraction.
  const errorCount = Math.max(0, declared - successCount);
  return {
    successCount,
    errorCount,
    rawStoredCount: Math.max(0, Math.trunc(input.rawStoredCount) || 0),
    status: errorCount > 0 ? "completed_with_errors" : "completed",
  };
}
