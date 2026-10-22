import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { requireServiceToken } from "@/app/lib/access";
import { reparseDailyReports } from "@/app/lib/daily-report-store";
import { route } from "@/app/lib/route";

/** パーサー・タグ辞書を変えてデプロイした後に、古い版で解析された日報を D1 の原本から最大20件ずつ作り直す。
 *  送信側が remaining が0になるまで繰り返し呼ぶ(§5.2)。Service Token からだけ受け付ける。 */
export const POST = route(async (request: Request) => {
  const denied = await requireServiceToken(request, env as unknown as Record<string, unknown>);
  if (denied) return denied;
  await ensureSchema({ seed: false });
  return Response.json(await reparseDailyReports());
});
