import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";

export async function POST(request: Request) {
  if (request.headers.get("x-cron-secret") !== (env as unknown as Record<string, string>).CRON_SECRET) return Response.json({ error: "forbidden" }, { status: 403 });
  await ensureSchema({ seed: false });
  if (!env.FILES) return Response.json({ error: "R2 unavailable" }, { status: 503 });
  let cursor: string | undefined; let count = 0; let bytes = 0;
  do { const page = await env.FILES.list({ cursor, limit: 1000 }); for (const object of page.objects) { count++; bytes += object.size; } cursor = page.truncated ? page.cursor : undefined; } while (cursor);
  const date = new Date().toISOString().slice(0,10); await env.DB.prepare("INSERT INTO storage_usage_daily (usage_date,object_count,payload_bytes,source,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(usage_date) DO UPDATE SET object_count=excluded.object_count,payload_bytes=excluded.payload_bytes,source=excluded.source,updated_at=excluded.updated_at").bind(date,count,bytes,"r2-list",new Date().toISOString()).run();
  return Response.json({ date, count, bytes });
}
