import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { requireServiceToken } from "@/app/lib/access";
import { deleteDailyReportSummary, isPeriodStart, isSummaryKind } from "@/app/lib/daily-report-summary-store";
import { route } from "@/app/lib/route";

/** 間違って送った週次・月次サマリを消す(§10)。Service Token からだけ受け付ける。 */
export const DELETE = route(async (request: Request, { params }: { params: Promise<{ kind: string; periodStart: string }> }) => {
  const denied = await requireServiceToken(request, env as unknown as Record<string, unknown>);
  if (denied) return denied;
  const { kind, periodStart } = await params;
  if (!isSummaryKind(kind)) return Response.json({ error: "kindはweekかmonthで指定してください。" }, { status: 400 });
  if (!isPeriodStart(kind, periodStart)) return Response.json({ error: "期間の始まりは、週なら月曜日、月なら1日のYYYY-MM-DDで指定してください。" }, { status: 400 });
  await ensureSchema({ seed: false });
  if (!(await deleteDailyReportSummary(kind, periodStart))) return Response.json({ error: "見つかりません。" }, { status: 404 });
  return Response.json({ deleted: { kind, periodStart } });
});
