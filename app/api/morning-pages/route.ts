import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { requireServiceToken } from "@/app/lib/access";
import { MAX_PAGES_PER_REQUEST } from "@/app/lib/morning-page-input";
import { ingestMorningPages } from "@/app/lib/morning-page-store";
import { route } from "@/app/lib/route";

/** auto-daily-report の morning_pages.py からの、モーニングページ(1ページ1件)の取り込み。
 *  本文は { pages: [{ date: "YYYY-MM-DD", startedAt, endedAt, minutes, place, chars, yesterday[], plan[], notes[], extracted }] }。
 *  同じ内容の再送は skipped で、何も書かない。1件の失敗はその件の error にして、全体は200で返す。Service Token からだけ受け付ける。 */
export const POST = route(async (request: Request) => {
  const denied = await requireServiceToken(request, env as unknown as Record<string, unknown>);
  if (denied) return denied;
  const body = await request.json().catch(() => null) as { pages?: unknown } | null;
  const pages = Array.isArray(body?.pages) ? body.pages : null;
  if (!pages?.length) return Response.json({ error: "pagesが必要です。" }, { status: 400 });
  if (pages.length > MAX_PAGES_PER_REQUEST) return Response.json({ error: `pagesは1リクエストあたり${MAX_PAGES_PER_REQUEST}件までです。` }, { status: 400 });
  await ensureSchema({ seed: false });
  const results = await ingestMorningPages(pages);
  const count = (status: string) => results.filter((result) => result.status === status).length;
  return Response.json({ created: count("created"), updated: count("updated"), skipped: count("skipped"), errors: count("error"), results });
});
