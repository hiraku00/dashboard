import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";

// Compatibility contract for the original manage-asset/static/app-ui.js.
export async function GET() {
  await ensureSchema({ seed: false });
  const raw = (await env.DB.prepare("SELECT record_type,payload_json FROM asset_history_records ORDER BY as_of_date ASC,captured_at ASC").all<{ record_type: string; payload_json: string }>()).results ?? [];
  const sources = (await env.DB.prepare("SELECT * FROM asset_sources WHERE enabled=1 ORDER BY display_name").all<Record<string, unknown>>()).results ?? [];
  const snapshots = raw.filter((row) => row.record_type === "wallet").map((row) => JSON.parse(row.payload_json));
  const exchange_snapshots = raw.filter((row) => row.record_type === "exchange").map((row) => JSON.parse(row.payload_json));
  const wallets = sources.filter((source) => source.source_type === "wallet").map((source) => ({ wallet_id: source.id, name: source.display_name, address: source.public_address, enabled: Boolean(source.enabled) }));
  return Response.json({ snapshots, exchange_snapshots, sources: sources.filter((source) => source.source_type !== "wallet").map((source) => ({ ...source, source_id: source.id, credential_configured: true })), wallets, daily_update: { errors: {} } });
}
