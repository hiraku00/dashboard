import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { reconcileStorageUsage } from "@/app/lib/storage-usage";
import { route } from "@/app/lib/route";

export const POST = route(async (request: Request) => {
  if (request.headers.get("x-cron-secret") !== (env as unknown as Record<string, string>).CRON_SECRET) return Response.json({ error: "forbidden" }, { status: 403 });
  await ensureSchema({ seed: false });
  if (!env.FILES) return Response.json({ error: "R2 unavailable" }, { status: 503 });
  // Same walk-and-record the daily cron runs; only the recorded source differs.
  return Response.json(await reconcileStorageUsage(env.FILES, env.DB, "r2-list"));
});
