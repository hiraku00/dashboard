/** ポータルTOP (app/page.tsx -> PortalHome) の集計（D1呼び出しを伴う
 *  オーケストレーション層）。app/api/portal/summary/route.ts と、後続で
 *  RSC化するポータルTOPページの両方がこれを呼ぶ想定 -- 正はここに一本化
 *  する。
 *
 *  純粋な決定ロジック（総額のフォールバック判定）は
 *  app/lib/portal-summary.ts に分離してある。理由は
 *  app/lib/watch-list-query.ts と同じ。 */
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { combineAssetTotals, type PortalSummary } from "@/app/lib/portal-summary";

export type { PortalSummary };

/** "Latest snapshot per source", the same rule assetState() uses in
 *  app/lib/queries/manage-asset.ts. asset_snapshots has UNIQUE(source_id,
 *  as_of_date), so a source's newest date identifies exactly one row, and the
 *  grouping is answered from that index (covering) instead of ranking every
 *  snapshot ever taken with ROW_NUMBER() -- 3,894 rows read to return 17,
 *  against 986 here (measured on production).
 *
 *  It replaces `ROW_NUMBER() ... ORDER BY captured_at DESC`, which chose by
 *  capture time. The two only differ for a source whose newest date was
 *  captured earlier than an older date (a re-sync of an old day); production has
 *  no such pair, and assetState() already chose by date, so the home page's
 *  total now agrees with Manage Asset's in that case too. */
const LATEST_SNAPSHOTS = `FROM asset_snapshots s
  JOIN (SELECT source_id, MAX(as_of_date) AS as_of_date FROM asset_snapshots GROUP BY source_id) latest
    ON latest.source_id = s.source_id AND latest.as_of_date = s.as_of_date`;

export async function portalSummary(): Promise<PortalSummary> {
  await ensureSchema({ seed: false });
  // One D1 round trip for everything. The positions are aggregated for the
  // latest snapshots by the same subquery, so they no longer wait on a first
  // query to learn those ids (that dependency is what made this three trips).
  const [watch, completed, textTube, latestVideo, latestAsset, sources, todoTotal, todoCompleted, latestSnapshotResult, positionResult] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL AND status='completed'"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM text_tube_videos WHERE deleted_at IS NULL"),
    env.DB.prepare("SELECT id,title,channel_name FROM text_tube_videos WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1"),
    env.DB.prepare("SELECT MAX(captured_at) AS latest_at FROM asset_snapshots"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM asset_sources WHERE enabled=1"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM todo_tasks WHERE deleted_at IS NULL AND occurrence_date = strftime('%Y-%m-%d','now','+7 hours')"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM todo_tasks WHERE deleted_at IS NULL AND occurrence_date = strftime('%Y-%m-%d','now','+7 hours') AND completed_at IS NOT NULL"),
    env.DB.prepare(`SELECT s.id, s.total_usd, s.total_jpy ${LATEST_SNAPSHOTS}`),
    env.DB.prepare(`SELECT snapshot_id, COALESCE(SUM(value_usd),0) AS total_usd, COALESCE(SUM(value_jpy),0) AS total_jpy FROM asset_positions WHERE snapshot_id IN (SELECT s.id ${LATEST_SNAPSHOTS}) GROUP BY snapshot_id`),
  ]);
  const latestSnapshots = (latestSnapshotResult.results ?? []) as Array<Record<string, unknown>>;
  const positionsBySnapshot = new Map<string, { usd: number; jpy: number }>();
  for (const row of positionResult.results ?? []) positionsBySnapshot.set(String(row.snapshot_id), { usd: Number(row.total_usd ?? 0), jpy: Number(row.total_jpy ?? 0) });
  const assetTotals = combineAssetTotals(latestSnapshots, positionsBySnapshot);
  const number = (result: D1Result<Record<string, unknown>>, key: string) => Number(result.results?.[0]?.[key] ?? 0);
  return {
    watch: { total: number(watch, "count"), completed: number(completed, "count") },
    textTube: { total: number(textTube, "count"), latest: (latestVideo.results?.[0] as PortalSummary["textTube"]["latest"]) ?? null },
    assets: { totalUsd: assetTotals.usd, totalJpy: assetTotals.jpy, latestAt: (latestAsset.results?.[0]?.latest_at as string | undefined) ?? null, sourceCount: number(sources, "count") },
    todo: { total: number(todoTotal, "count"), completed: number(todoCompleted, "count") },
  };
}
