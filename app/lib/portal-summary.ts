/** Pure decision logic for the portal summary's asset totals -- no D1, no
 *  I/O. Kept separate from app/lib/queries/portal.ts (which does the actual
 *  D1 calls) for the same reason as app/lib/watch-list-query.ts: a module
 *  that imports "cloudflare:workers" cannot be loaded under plain
 *  `node --test` at all, let alone unit tested. */

export type PortalSummary = {
  watch: { total: number; completed: number };
  textTube: { total: number; latest: { id: string; title: string; channel_name: string } | null };
  assets: { totalUsd: number; totalJpy: number; latestAt: string | null; sourceCount: number };
  todo: { total: number; completed: number };
};

/** A snapshot's own total_usd/total_jpy wins when non-zero (the normal
 *  case); falling back to summing that snapshot's positions covers the
 *  older rows from before totals were stored on the snapshot itself. */
export function combineAssetTotals(
  snapshots: Array<Record<string, unknown>>,
  positionsBySnapshot: Map<string, { usd: number; jpy: number }>,
): { usd: number; jpy: number } {
  return snapshots.reduce<{ usd: number; jpy: number }>((totals, row) => {
    const positionTotals = positionsBySnapshot.get(String(row.id));
    const storedUsd = Number(row.total_usd ?? 0);
    const storedJpy = Number(row.total_jpy ?? 0);
    totals.usd += storedUsd || positionTotals?.usd || 0;
    totals.jpy += storedJpy || positionTotals?.jpy || 0;
    return totals;
  }, { usd: 0, jpy: 0 });
}
