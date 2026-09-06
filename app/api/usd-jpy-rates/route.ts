import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { route } from "@/app/lib/route";
export const GET = route(async () => { await ensureSchema({ seed: false }); const rows = (await env.DB.prepare("SELECT payload_json FROM asset_fx_rates ORDER BY rate_date ASC").all<{ payload_json: string }>()).results ?? []; return Response.json({ rows: rows.map((row) => JSON.parse(row.payload_json)) }); });
