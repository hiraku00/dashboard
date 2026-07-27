import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { currentStorageBytes, R2_SOFT_LIMIT_BYTES } from "@/app/lib/portal";

export async function GET() {
  await ensureSchema({ seed: false });
  const usage = await currentStorageBytes();
  const categories = (await env.DB.prepare("SELECT category, COUNT(*) AS count, COALESCE(SUM(size_bytes),0) AS bytes FROM storage_objects WHERE deleted_at IS NULL GROUP BY category ORDER BY bytes DESC").all<Record<string, unknown>>()).results ?? [];
  const latest = (await env.DB.prepare("SELECT * FROM storage_usage_daily ORDER BY usage_date DESC LIMIT 1").all<Record<string, unknown>>()).results?.[0] ?? null;
  return Response.json({ softLimitBytes: R2_SOFT_LIMIT_BYTES, usage, categories, latestReconciliation: latest });
}
