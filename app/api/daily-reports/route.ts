import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { requireServiceToken } from "@/app/lib/access";
import { ingestDailyReports, MAX_REPORTS_PER_REQUEST } from "@/app/lib/daily-report-store";
import { route } from "@/app/lib/route";

/** auto-daily-report からの日報の取り込み(docs/daily-report-ingest-design.md §5.1)。
 *  本文は { reports: [{ date: "YYYY-MM-DD", markdown }] }。同じ内容の再送は skipped で、何も書かない。
 *  1件の失敗はその件の error にして、全体は200で返す。Service Token からだけ受け付ける。 */
export const POST = route(async (request: Request) => {
  const denied = await requireServiceToken(request, env as unknown as Record<string, unknown>);
  if (denied) return denied;
  const body = await request.json().catch(() => null) as { reports?: unknown } | null;
  const reports = Array.isArray(body?.reports) ? body.reports : null;
  if (!reports?.length) return Response.json({ error: "reportsが必要です。" }, { status: 400 });
  if (reports.length > MAX_REPORTS_PER_REQUEST) return Response.json({ error: `reportsは1リクエストあたり${MAX_REPORTS_PER_REQUEST}件までです。` }, { status: 400 });
  await ensureSchema({ seed: false });
  const results = await ingestDailyReports(reports.map((report) => (report && typeof report === "object" ? report : {}) as { date: unknown; markdown: unknown }));
  const count = (status: string) => results.filter((result) => result.status === status).length;
  return Response.json({ created: count("created"), updated: count("updated"), skipped: count("skipped"), errors: count("error"), results });
});
