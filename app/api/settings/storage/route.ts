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
  // D1's free-tier limit resets daily at UTC 00:00, so "today" here must be
  // the UTC date, not the 30-day rolling total below — otherwise this panel
  // cannot tell whether today alone is close to the daily cap.
  const today = end;
  const analyticsResponse = await fetch(
    "https://api.cloudflare.com/client/v4/graphql",
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        query: `query D1Usage($accountTag: string!, $today: Date, $start: Date, $end: Date, $databaseId: string) {
          viewer { accounts(filter: { accountTag: $accountTag }) {
            today: d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $today, date_leq: $today, databaseId: $databaseId }) {
              sum { readQueries writeQueries rowsRead rowsWritten }
            }
            last30Days: d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $start, date_leq: $end, databaseId: $databaseId }) {
              sum { readQueries writeQueries rowsRead rowsWritten }
            }
          } }
        }`,
        variables: {
          accountTag: runtime.CF_ACCOUNT_ID,
          today,
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
          today?: Array<{ sum?: Record<string, number> }>;
          last30Days?: Array<{ sum?: Record<string, number> }>;
        }>;
      };
    };
  };
  const account = analyticsBody.data?.viewer?.accounts?.[0];
  const sumOf = (rows: Array<{ sum?: Record<string, number> }> = []) =>
    rows.reduce(
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
    today: { date: today, ...sumOf(account?.today) },
    last30Days: sumOf(account?.last30Days),
  };
}

const emptyD1Records = {
  usage: { bytes: 0, count: 0 },
  categories: [] as Record<string, unknown>[],
  latest: null as Record<string, unknown> | null,
  databaseRecords: { watchList: 0, manageAsset: 0, textTube: 0 },
  transcriptUsage: { credits: 0, attempts: 0, lastUsedAt: null as string | null },
};

// D1's own daily row-read/write cap (separate from the Cloudflare Analytics
// API used by d1Usage() below) can make every one of these queries fail at
// once. When it does, this route must still return 200 with the Analytics
// numbers intact — those come from a different API and are not blocked by
// the D1 query cap — instead of failing the whole usage page exactly when a
// D1 outage is the thing the page exists to explain.
async function d1QueryBackedFields(month: string) {
  try {
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
    const [watchList, manageAsset, textTube] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL").all<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM asset_snapshots").all<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM text_tube_videos WHERE deleted_at IS NULL").all<{ count: number }>(),
    ]);
    const transcriptUsage = (
      await env.DB.prepare(
        "SELECT COALESCE(SUM(credits),0) AS credits, COUNT(*) AS attempts, MAX(created_at) AS last_used_at FROM text_tube_api_usage WHERE provider='supadata' AND substr(created_at,1,7)=?",
      )
        .bind(month)
        .all<{ credits: number; attempts: number; last_used_at: string | null }>()
    ).results?.[0] ?? { credits: 0, attempts: 0, last_used_at: null };
    return {
      ok: true as const,
      usage,
      categories,
      latest,
      databaseRecords: {
        watchList: Number(watchList.results?.[0]?.count ?? 0),
        manageAsset: Number(manageAsset.results?.[0]?.count ?? 0),
        textTube: Number(textTube.results?.[0]?.count ?? 0),
      },
      transcriptUsage: {
        credits: Number(transcriptUsage.credits ?? 0),
        attempts: Number(transcriptUsage.attempts ?? 0),
        lastUsedAt: transcriptUsage.last_used_at ?? null,
      },
    };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "D1クエリが失敗しました。", ...emptyD1Records };
  }
}

export async function GET() {
  const month = new Date().toISOString().slice(0, 7);
  const [d1Query, d1] = await Promise.all([
    d1QueryBackedFields(month),
    d1Usage().catch(() => ({ configured: false as const })),
  ]);
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
}
