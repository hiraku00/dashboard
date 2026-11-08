import { env } from "cloudflare:workers";
import { ensureSchema, ensureWallet2Schema } from "@/db";
import { reconcileStorageUsage } from "@/app/lib/storage-usage";
import { measureAllD1Tables } from "@/app/lib/d1-table-usage";
import { route } from "@/app/lib/route";

export const POST = route(async (request: Request) => {
  if (request.headers.get("x-cron-secret") !== (env as unknown as Record<string, string>).CRON_SECRET) return Response.json({ error: "forbidden" }, { status: 403 });
  await ensureSchema({ seed: false });
  await ensureWallet2Schema().catch((error) => console.error("ウォレット2の DB を準備できませんでした", error));
  if (!env.FILES) return Response.json({ error: "R2 unavailable" }, { status: 503 });
  // Same walk-and-record the daily cron runs; only the recorded source differs.
  const r2 = await reconcileStorageUsage(env.FILES, env.DB, "r2-list");
  // D1 のテーブルごとの容量も、日次の cron と同じく測り直す(手動で今日の分を取り直したいとき用)
  const d1 = await measureAllD1Tables(env.DB, env.DB_WALLET2);
  return Response.json({ ...r2, d1Tables: d1.tables.length });
});
