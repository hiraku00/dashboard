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
import { ROOM } from "@/app/lib/openchat-query";
import { assetTotals, type PortalSummary } from "@/app/lib/portal-summary";
import { LATEST_SNAPSHOT_JOIN } from "@/app/lib/manage-asset-latest-snapshot";

export type { PortalSummary };

/** "Latest snapshot per source", via the same JOIN assetState() uses in
 *  app/lib/queries/manage-asset.ts, so the totals come out of the same rows
 *  Manage Asset totals -- see manage-asset-latest-snapshot.ts. */
const LATEST_SNAPSHOTS = `SELECT s.id, s.source_id, s.captured_at, s.as_of_date, s.fx_usdjpy, s.total_usd, s.total_jpy, a.source_type, a.display_name
  ${LATEST_SNAPSHOT_JOIN}
  ORDER BY s.total_usd DESC`;

export async function portalSummary(): Promise<PortalSummary> {
  await ensureSchema({ seed: false });
  // One D1 round trip for everything.
  const [watch, completed, textTube, latestVideo, latestAsset, sources, todoTotal, todoCompleted, latestSnapshotResult, openchat] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL AND status='completed'"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM text_tube_videos WHERE deleted_at IS NULL"),
    env.DB.prepare("SELECT id,title,channel_name FROM text_tube_videos WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1"),
    env.DB.prepare("SELECT MAX(captured_at) AS latest_at FROM asset_snapshots"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM asset_sources WHERE enabled=1"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM todo_tasks WHERE deleted_at IS NULL AND occurrence_date = strftime('%Y-%m-%d','now','+7 hours')"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM todo_tasks WHERE deleted_at IS NULL AND occurrence_date = strftime('%Y-%m-%d','now','+7 hours') AND completed_at IS NOT NULL"),
    env.DB.prepare(LATEST_SNAPSHOTS),
    // /chikirin の一覧に載るノートと同じ条件(app/lib/openchat-query.ts の buildProgramsFilter の既定)。
    env.DB.prepare("SELECT COUNT(*) AS count, MAX(posted_at) AS latest_at FROM openchat_notes WHERE room = ? AND deleted_at IS NULL AND (author_is_target = 1 OR target_comment_count > 0)").bind(ROOM),
  ]);
  const latestSnapshots = (latestSnapshotResult.results ?? []) as Array<Record<string, unknown>>;
  const totals = assetTotals(latestSnapshots);
  const number = (result: D1Result<Record<string, unknown>>, key: string) => Number(result.results?.[0]?.[key] ?? 0);
  return {
    watch: { total: number(watch, "count"), completed: number(completed, "count") },
    textTube: { total: number(textTube, "count"), latest: (latestVideo.results?.[0] as PortalSummary["textTube"]["latest"]) ?? null },
    assets: { totalUsd: totals.usd, totalJpy: totals.jpy, latestAt: (latestAsset.results?.[0]?.latest_at as string | undefined) ?? null, sourceCount: number(sources, "count") },
    todo: { total: number(todoTotal, "count"), completed: number(todoCompleted, "count") },
    openchat: { total: number(openchat, "count"), latestPostedAt: (openchat.results?.[0]?.latest_at as string | undefined) ?? null },
  };
}
