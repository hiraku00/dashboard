import { R2_SOFT_LIMIT_BYTES } from "@/app/lib/portal";
import { cloudflareAnalyticsUsage, d1BackedUsage } from "@/app/lib/queries/storage-usage";
import { route } from "@/app/lib/route";

export const GET = route(async () => {
  const month = new Date().toISOString().slice(0, 7);
  const [d1Query, d1] = await Promise.all([d1BackedUsage(month), cloudflareAnalyticsUsage()]);
  return Response.json({
    softLimitBytes: R2_SOFT_LIMIT_BYTES,
    usage: d1Query.usage,
    categories: d1Query.categories,
    databaseRecords: d1Query.databaseRecords,
    latestReconciliation: d1Query.latest,
    transcriptUsage: { month, ...d1Query.transcriptUsage },
    d1,
    d1QueryOk: d1Query.ok,
    d1QueryError: d1Query.ok ? null : d1Query.error,
  });
});
