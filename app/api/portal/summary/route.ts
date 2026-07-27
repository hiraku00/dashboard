import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";

export async function GET() {
  await ensureSchema({ seed: false });
  const [watch, completed, textTube, latestVideo, assetTotals, latestAsset, sources] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL AND status='completed'"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM text_tube_videos WHERE deleted_at IS NULL"),
    env.DB.prepare("SELECT id,title,channel_name FROM text_tube_videos WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1"),
    env.DB.prepare("SELECT COALESCE(SUM(total_usd),0) AS total_usd, COALESCE(SUM(total_jpy),0) AS total_jpy FROM asset_snapshots s WHERE s.id IN (SELECT id FROM asset_snapshots x WHERE x.source_id=s.source_id ORDER BY x.captured_at DESC LIMIT 1)"),
    env.DB.prepare("SELECT MAX(captured_at) AS latest_at FROM asset_snapshots"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM asset_sources WHERE enabled=1"),
  ]);
  const number = (result: D1Result<Record<string, unknown>>, key: string) => Number(result.results?.[0]?.[key] ?? 0);
  return Response.json({
    watch: { total: number(watch, "count"), completed: number(completed, "count") },
    textTube: { total: number(textTube, "count"), latest: latestVideo.results?.[0] ?? null },
    assets: { totalUsd: number(assetTotals, "total_usd"), totalJpy: number(assetTotals, "total_jpy"), latestAt: latestAsset.results?.[0]?.latest_at ?? null, sourceCount: number(sources, "count") },
  });
}
