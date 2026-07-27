import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
export async function GET() { await ensureSchema({ seed: false }); const rows = (await env.DB.prepare("SELECT payload_json FROM asset_lido_rewards ORDER BY reward_date ASC").all<{ payload_json: string }>()).results ?? []; return Response.json({ rows: rows.map((row) => JSON.parse(row.payload_json)) }); }
