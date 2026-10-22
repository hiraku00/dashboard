import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { measureD1Tables, measuredToday } from "@/app/lib/d1-table-usage";
import { route } from "@/app/lib/route";

/** 使用量画面の「今日の分を計測」ボタン。D1 のテーブルごとの容量を、今日(バンコク時間)の分がまだ無いときだけ測る。
 *  全テーブルを全件読むので、1日1回に限る(押し直しても2回目は測らずに 409 を返す)。 */
export const POST = route(async () => {
  await ensureSchema({ seed: false });
  if (await measuredToday(env.DB)) {
    return Response.json({ error: "今日の分はもう計測しています。", measured: false }, { status: 409 });
  }
  const result = await measureD1Tables(env.DB);
  return Response.json({ measured: true, date: result.date, tables: result.tables.length });
});
