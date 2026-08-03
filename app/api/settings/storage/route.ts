import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { currentStorageBytes, R2_SOFT_LIMIT_BYTES } from "@/app/lib/portal";

const D1_DATABASE_ID = "a88eabc6-5b74-48e8-b347-07720d2297d1";

async function d1Usage() {
  const runtime = env as typeof env & {
    CF_ANALYTICS_TOKEN?: string;
    CF_ACCOUNT_ID?: string;
  };
  if (!runtime.CF_ANALYTICS_TOKEN || !runtime.CF_ACCOUNT_ID)
    return { configured: false };
  const headers = { Authorization: `Bearer ${runtime.CF_ANALYTICS_TOKEN}` };
  const sizeResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${runtime.CF_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}`,
    { headers },
  );
  const sizeBody = (await sizeResponse.json()) as {
    result?: { file_size?: number };
  };
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 29 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const analyticsResponse = await fetch(
    "https://api.cloudflare.com/client/v4/graphql",
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        query: `query D1Usage($accountTag: string!, $start: Date, $end: Date, $databaseId: string) {
          viewer { accounts(filter: { accountTag: $accountTag }) {
            d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $start, date_leq: $end, databaseId: $databaseId }) {
              sum { readQueries writeQueries rowsRead rowsWritten }
            }
          } }
        }`,
        variables: {
          accountTag: runtime.CF_ACCOUNT_ID,
          start,
          end,
          databaseId: D1_DATABASE_ID,
        },
      }),
    },
  );
  const analyticsBody = (await analyticsResponse.json()) as {
    data?: {
      viewer?: {
        accounts?: Array<{
          d1AnalyticsAdaptiveGroups?: Array<{
            sum?: Record<string, number>;
          }>;
        }>;
      };
    };
  };
  const sums =
    analyticsBody.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
  const total = sums.reduce(
    (result, row) => ({
      readQueries: result.readQueries + Number(row.sum?.readQueries ?? 0),
      writeQueries: result.writeQueries + Number(row.sum?.writeQueries ?? 0),
      rowsRead: result.rowsRead + Number(row.sum?.rowsRead ?? 0),
      rowsWritten: result.rowsWritten + Number(row.sum?.rowsWritten ?? 0),
    }),
    { readQueries: 0, writeQueries: 0, rowsRead: 0, rowsWritten: 0 },
  );
  return {
    configured: sizeResponse.ok && analyticsResponse.ok,
    storageBytes: Number(sizeBody.result?.file_size ?? 0),
    period: { start, end },
    ...total,
  };
}

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
  const d1 = await d1Usage().catch(() => ({ configured: false }));
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
    d1,
  });
}
