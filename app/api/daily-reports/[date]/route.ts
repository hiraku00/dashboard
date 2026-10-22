import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { requireServiceToken } from "@/app/lib/access";
import { deleteDailyReport, isReportDate } from "@/app/lib/daily-report-store";
import { route } from "@/app/lib/route";

/** 間違って送った日報を、正規化・タグ・改訂も含めて消す(§5.3)。Service Token からだけ受け付ける。 */
export const DELETE = route(async (request: Request, { params }: { params: Promise<{ date: string }> }) => {
  const denied = await requireServiceToken(request, env as unknown as Record<string, unknown>);
  if (denied) return denied;
  const { date } = await params;
  if (!isReportDate(date)) return Response.json({ error: "日付はYYYY-MM-DDで指定してください。" }, { status: 400 });
  await ensureSchema({ seed: false });
  if (!(await deleteDailyReport(date))) return Response.json({ error: "見つかりません。" }, { status: 404 });
  return Response.json({ deleted: date });
});
