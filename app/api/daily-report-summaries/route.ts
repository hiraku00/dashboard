import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { requireServiceToken } from "@/app/lib/access";
import { ingestDailyReportSummaries, MAX_SUMMARIES_PER_REQUEST } from "@/app/lib/daily-report-summary-store";
import { route } from "@/app/lib/route";

/** auto-daily-report からの週次・月次サマリの取り込み(docs/daily-report-ingest-design.md §10)。
 *  本文は { summaries: [{ kind: "week" | "month", periodStart, periodEnd, markdown }] }。同じ内容の再送は skipped で、何も書かない。
 *  1件の失敗はその件の error にして、全体は200で返す。Service Token からだけ受け付ける。 */
export const POST = route(async (request: Request) => {
  const denied = await requireServiceToken(request, env as unknown as Record<string, unknown>);
  if (denied) return denied;
  const body = await request.json().catch(() => null) as { summaries?: unknown } | null;
  const summaries = Array.isArray(body?.summaries) ? body.summaries : null;
  if (!summaries?.length) return Response.json({ error: "summariesが必要です。" }, { status: 400 });
  if (summaries.length > MAX_SUMMARIES_PER_REQUEST) return Response.json({ error: `summariesは1リクエストあたり${MAX_SUMMARIES_PER_REQUEST}件までです。` }, { status: 400 });
  await ensureSchema({ seed: false });
  const results = await ingestDailyReportSummaries(summaries.map((summary) =>
    (summary && typeof summary === "object" ? summary : {}) as { kind: unknown; periodStart: unknown; periodEnd: unknown; markdown: unknown }));
  const count = (status: string) => results.filter((result) => result.status === status).length;
  return Response.json({ created: count("created"), updated: count("updated"), skipped: count("skipped"), errors: count("error"), results });
});
