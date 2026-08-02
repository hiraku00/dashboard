import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { currentStorageBytes, R2_SOFT_LIMIT_BYTES } from "@/app/lib/portal";

export async function GET() {
  await ensureSchema({ seed: false });
  const usage = await currentStorageBytes();
  const categories =
    (
      await env.DB.prepare(
        "SELECT category, COUNT(*) AS count, COALESCE(SUM(size_bytes),0) AS bytes FROM storage_objects WHERE deleted_at IS NULL GROUP BY category ORDER BY bytes DESC",
      ).all<Record<string, unknown>>()
    ).results ?? [];
  const latest =
    (
      await env.DB.prepare(
        "SELECT * FROM storage_usage_daily ORDER BY usage_date DESC LIMIT 1",
      ).all<Record<string, unknown>>()
    ).results?.[0] ?? null;
  const month = new Date().toISOString().slice(0, 7);
  const transcriptUsage = (
    await env.DB.prepare(
      "SELECT COALESCE(SUM(credits),0) AS credits, COUNT(*) AS attempts, MAX(created_at) AS last_used_at FROM text_tube_api_usage WHERE provider='supadata' AND substr(created_at,1,7)=?",
    )
      .bind(month)
      .all<{ credits: number; attempts: number; last_used_at: string | null }>()
  ).results?.[0] ?? { credits: 0, attempts: 0, last_used_at: null };
  return Response.json({
    softLimitBytes: R2_SOFT_LIMIT_BYTES,
    usage,
    categories,
    latestReconciliation: latest,
    transcriptUsage: {
      month,
      credits: Number(transcriptUsage.credits ?? 0),
      attempts: Number(transcriptUsage.attempts ?? 0),
      lastUsedAt: transcriptUsage.last_used_at ?? null,
    },
  });
}
