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

export async function portalSummary(): Promise<PortalSummary> {
  await ensureSchema({ seed: false });
  const [watch, completed, textTube, latestVideo, latestAsset, sources, todoTotal, todoCompleted] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL AND status='completed'"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM text_tube_videos WHERE deleted_at IS NULL"),
    env.DB.prepare("SELECT id,title,channel_name FROM text_tube_videos WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1"),
    env.DB.prepare("SELECT MAX(captured_at) AS latest_at FROM asset_snapshots"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM asset_sources WHERE enabled=1"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM todo_tasks WHERE deleted_at IS NULL AND occurrence_date = strftime('%Y-%m-%d','now','+7 hours')"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM todo_tasks WHERE deleted_at IS NULL AND occurrence_date = strftime('%Y-%m-%d','now','+7 hours') AND completed_at IS NOT NULL"),
  ]);
  // A per-row correlated subquery here re-scans asset_snapshots once per
  // outer row; a single ROW_NUMBER() pass computes the same "latest
  // snapshot per source" result in one scan instead.
  const latestSnapshots = (await env.DB.prepare(`WITH ranked AS (
    SELECT id, total_usd, total_jpy,
      ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY captured_at DESC) AS rn
    FROM asset_snapshots
  )
  SELECT id, total_usd, total_jpy FROM ranked WHERE rn = 1`).all<Record<string, unknown>>()).results ?? [];
  const snapshotIds = latestSnapshots.map((row) => String(row.id ?? "")).filter(Boolean);
  const positionsBySnapshot = new Map<string, { usd: number; jpy: number }>();
  if (snapshotIds.length) {
    const placeholders = snapshotIds.map(() => "?").join(",");
    const positions = (await env.DB.prepare(`SELECT snapshot_id, COALESCE(SUM(value_usd),0) AS total_usd, COALESCE(SUM(value_jpy),0) AS total_jpy FROM asset_positions WHERE snapshot_id IN (${placeholders}) GROUP BY snapshot_id`).bind(...snapshotIds).all<Record<string, unknown>>()).results ?? [];
    for (const row of positions) positionsBySnapshot.set(String(row.snapshot_id), { usd: Number(row.total_usd ?? 0), jpy: Number(row.total_jpy ?? 0) });
  }
  const assetTotals = combineAssetTotals(latestSnapshots, positionsBySnapshot);
  const number = (result: D1Result<Record<string, unknown>>, key: string) => Number(result.results?.[0]?.[key] ?? 0);
  return {
    watch: { total: number(watch, "count"), completed: number(completed, "count") },
    textTube: { total: number(textTube, "count"), latest: (latestVideo.results?.[0] as PortalSummary["textTube"]["latest"]) ?? null },
    assets: { totalUsd: assetTotals.usd, totalJpy: assetTotals.jpy, latestAt: (latestAsset.results?.[0]?.latest_at as string | undefined) ?? null, sourceCount: number(sources, "count") },
    todo: { total: number(todoTotal, "count"), completed: number(todoCompleted, "count") },
  };
}
