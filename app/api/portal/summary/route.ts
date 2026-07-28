import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";

export async function GET() {
  await ensureSchema({ seed: false });
  const [watch, completed, textTube, latestVideo, latestAsset, sources] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL AND status='completed'"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM text_tube_videos WHERE deleted_at IS NULL"),
    env.DB.prepare("SELECT id,title,channel_name FROM text_tube_videos WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1"),
    env.DB.prepare("SELECT MAX(captured_at) AS latest_at FROM asset_snapshots"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM asset_sources WHERE enabled=1"),
  ]);
  const latestSnapshots = (await env.DB.prepare("SELECT s.id, s.total_usd, s.total_jpy FROM asset_snapshots s WHERE s.id IN (SELECT id FROM asset_snapshots x WHERE x.source_id=s.source_id ORDER BY x.captured_at DESC LIMIT 1)").all<Record<string, unknown>>()).results ?? [];
  const snapshotIds = latestSnapshots.map((row) => String(row.id ?? "")).filter(Boolean);
  const positionsBySnapshot = new Map<string, { usd: number; jpy: number }>();
  if (snapshotIds.length) {
    const placeholders = snapshotIds.map(() => "?").join(",");
    const positions = (await env.DB.prepare(`SELECT snapshot_id, COALESCE(SUM(value_usd),0) AS total_usd, COALESCE(SUM(value_jpy),0) AS total_jpy FROM asset_positions WHERE snapshot_id IN (${placeholders}) GROUP BY snapshot_id`).bind(...snapshotIds).all<Record<string, unknown>>()).results ?? [];
    for (const row of positions) positionsBySnapshot.set(String(row.snapshot_id), { usd: Number(row.total_usd ?? 0), jpy: Number(row.total_jpy ?? 0) });
  }
  const assetTotals = latestSnapshots.reduce((totals, row) => {
    const positionTotals = positionsBySnapshot.get(String(row.id));
    const storedUsd = Number(row.total_usd ?? 0);
    const storedJpy = Number(row.total_jpy ?? 0);
    totals.usd += storedUsd || positionTotals?.usd || 0;
    totals.jpy += storedJpy || positionTotals?.jpy || 0;
    return totals;
  }, { usd: 0, jpy: 0 });
  const number = (result: D1Result<Record<string, unknown>>, key: string) => Number(result.results?.[0]?.[key] ?? 0);
  return Response.json({
    watch: { total: number(watch, "count"), completed: number(completed, "count") },
    textTube: { total: number(textTube, "count"), latest: latestVideo.results?.[0] ?? null },
    assets: { totalUsd: assetTotals.usd, totalJpy: assetTotals.jpy, latestAt: latestAsset.results?.[0]?.latest_at ?? null, sourceCount: number(sources, "count") },
  });
}
