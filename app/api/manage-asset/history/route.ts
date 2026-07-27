import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { currencyHistory, holdingsFromPositions, historyPoints, stethRewardHistory, walletPositions, exchangePositions } from "@/app/lib/manage-asset-core";

export async function GET() {
  await ensureSchema({ seed: false });
  const records = (await env.DB.prepare("SELECT * FROM asset_history_records ORDER BY as_of_date ASC, captured_at ASC").all<Record<string, unknown>>()).results ?? [];
  const snapshots = records.filter(row => row.record_type === "wallet").map(row => JSON.parse(String(row.payload_json)));
  const exchangeSnapshots = records.filter(row => row.record_type === "exchange").map(row => JSON.parse(String(row.payload_json)));
  const lidoRewards = (await env.DB.prepare("SELECT payload_json FROM asset_lido_rewards ORDER BY reward_date ASC").all<Record<string, unknown>>()).results?.map(row => JSON.parse(String(row.payload_json))) ?? [];
  const rates = (await env.DB.prepare("SELECT payload_json FROM asset_fx_rates ORDER BY rate_date ASC").all<Record<string, unknown>>()).results?.map(row => JSON.parse(String(row.payload_json))) ?? [];
  const positions = [...walletPositions(snapshots), ...exchangePositions(exchangeSnapshots)];
  const holdings = holdingsFromPositions(positions);
  const steth = stethRewardHistory(lidoRewards, snapshots, exchangeSnapshots, rates);
  const symbols = [...new Set([...holdings.map((row) => row.symbol), ...(steth.length ? ["stETH"] : [])])].sort((a, b) => a.localeCompare(b));
  return Response.json({
    snapshots,
    exchange_snapshots: exchangeSnapshots,
    lido_rewards: lidoRewards,
    rates,
    points: historyPoints(snapshots, exchangeSnapshots),
    holdings,
    symbols,
    currencies: Object.fromEntries(symbols.map((symbol) => [symbol, symbol.toLowerCase() === "steth" ? steth : currencyHistory(snapshots, exchangeSnapshots, symbol, rates)])),
  });
}
