import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { route } from "@/app/lib/route";

type HistoryRow = Record<string, unknown>;
const number = (value: unknown) => { const result = Number(value); return Number.isFinite(result) ? result : 0; };
const text = (value: unknown) => String(value ?? "");

export const POST = route(async (request: Request) => {
  await ensureSchema({ seed: false });
  const body = await request.json().catch(() => null) as { snapshots?: HistoryRow[]; exchangeSnapshots?: HistoryRow[]; lidoRewards?: HistoryRow[]; rates?: HistoryRow[] } | null;
  if (!body) return Response.json({ error: "履歴データが不正です。" }, { status: 400 });
  const rows: D1PreparedStatement[] = [];
  for (const [recordType, input] of [["wallet", body.snapshots ?? []], ["exchange", body.exchangeSnapshots ?? []]] as const) {
    for (const row of input) {
      const sourceId = text(row.wallet_id ?? row.source_id);
      const asOfDate = text(row.as_of_date).slice(0, 10);
      const capturedAt = text(row.captured_at);
      if (!sourceId || !asOfDate || !capturedAt) continue;
      const totalUsd = number(row.total_usd ?? (row.totals as HistoryRow | undefined)?.net_asset_usd);
      const totalJpy = number(row.total_jpy);
      const fx = number(row.fx_usdjpy) || null;
      rows.push(env.DB.prepare(`INSERT INTO asset_history_records (id,record_type,source_id,as_of_date,captured_at,total_usd,total_jpy,fx_usdjpy,payload_json) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(record_type,source_id,as_of_date,captured_at) DO UPDATE SET total_usd=excluded.total_usd,total_jpy=excluded.total_jpy,fx_usdjpy=excluded.fx_usdjpy,payload_json=excluded.payload_json`).bind(crypto.randomUUID(), recordType, sourceId, asOfDate, capturedAt, totalUsd, totalJpy, fx, JSON.stringify(row)));
    }
  }
  for (const row of body.lidoRewards ?? []) {
    const rewardDate = text(row.date); if (!rewardDate) continue;
    rows.push(env.DB.prepare(`INSERT INTO asset_lido_rewards (id,reward_date,reward_type,change,change_usd,apr,balance,payload_json) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(reward_date,reward_type,change,balance) DO UPDATE SET change_usd=excluded.change_usd,apr=excluded.apr,payload_json=excluded.payload_json`).bind(crypto.randomUUID(), rewardDate, text(row.type) || "reward", number(row.change), number(row.change_USD), number(row.apr), number(row.balance), JSON.stringify(row)));
  }
  for (const row of body.rates ?? []) {
    const rateDate = text(row.date).slice(0, 10); const rate = number(row.rate); if (!rateDate || !rate) continue;
    rows.push(env.DB.prepare(`INSERT INTO asset_fx_rates (rate_date,rate,payload_json) VALUES (?,?,?) ON CONFLICT(rate_date) DO UPDATE SET rate=excluded.rate,payload_json=excluded.payload_json`).bind(rateDate, rate, JSON.stringify(row)));
  }
  for (let start = 0; start < rows.length; start += 50) await env.DB.batch(rows.slice(start, start + 50));
  return Response.json({ ok: true, imported: rows.length });
});
