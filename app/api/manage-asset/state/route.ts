import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";

export async function GET() {
  await ensureSchema({ seed: false });
  const sources = (await env.DB.prepare("SELECT * FROM asset_sources WHERE enabled=1 ORDER BY display_name").all<Record<string, unknown>>()).results ?? [];
  const snapshots = (await env.DB.prepare("SELECT s.*, a.display_name, a.provider FROM asset_snapshots s JOIN asset_sources a ON a.id=s.source_id WHERE s.id IN (SELECT id FROM asset_snapshots x WHERE x.source_id=s.source_id ORDER BY x.captured_at DESC LIMIT 1) ORDER BY s.total_usd DESC").all<Record<string, unknown>>()).results ?? [];
  const history = (await env.DB.prepare("SELECT as_of_date, SUM(total_usd) AS total_usd, SUM(total_jpy) AS total_jpy FROM asset_snapshots GROUP BY as_of_date ORDER BY as_of_date DESC LIMIT 90").all<Record<string, unknown>>()).results ?? [];
  const runs = (await env.DB.prepare("SELECT * FROM asset_sync_runs ORDER BY received_at DESC LIMIT 20").all<Record<string, unknown>>()).results ?? [];
  const positions = (await env.DB.prepare(`SELECT p.*, a.display_name, a.provider FROM asset_positions p JOIN asset_snapshots s ON s.id=p.snapshot_id JOIN asset_sources a ON a.id=s.source_id WHERE s.id IN (SELECT id FROM asset_snapshots x WHERE x.source_id=s.source_id ORDER BY x.captured_at DESC LIMIT 1) ORDER BY p.value_usd DESC`).all<Record<string, unknown>>()).results ?? [];
  const holdings = Object.values(positions.reduce<Record<string, Record<string, unknown>>>((acc, row) => { const key=String(row.symbol); const item=acc[key]??={symbol:key,quantity:0,value_usd:0,value_jpy:0,locations:[]}; item.quantity=Number(item.quantity)+Number(row.quantity??0); item.value_usd=Number(item.value_usd)+Number(row.value_usd??0); item.value_jpy=Number(item.value_jpy)+Number(row.value_jpy??0); (item.locations as Array<Record<string,unknown>>).push(row); return acc; }, {})).sort((a,b)=>Number(b.value_usd)-Number(a.value_usd));
  return Response.json({ sources, snapshots, history, runs, positions, holdings });
}
