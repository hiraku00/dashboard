import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { currencyHistory, holdingsFromPositions, historyPoints, stethRewardHistory, walletPositions, exchangePositions } from "@/app/lib/manage-asset-core";

export async function GET() {
  await ensureSchema({ seed: false });
  const records = (await env.DB.prepare("SELECT * FROM asset_history_records ORDER BY as_of_date ASC, captured_at ASC").all<Record<string, unknown>>()).results ?? [];
  let snapshots = records.filter(row => row.record_type === "wallet").map(row => JSON.parse(String(row.payload_json)));
  let exchangeSnapshots = records.filter(row => row.record_type === "exchange").map(row => JSON.parse(String(row.payload_json)));

  // The daily collector writes the normalized current snapshot tables, while
  // the migration endpoint writes the legacy history table. Merge both here so
  // today's data is available to the same charts as imported history.
  const normalized = (await env.DB.prepare(`SELECT s.*, a.source_type, a.display_name, a.public_address
    FROM asset_snapshots s JOIN asset_sources a ON a.id=s.source_id
    ORDER BY s.as_of_date ASC, s.captured_at ASC`).all<Record<string, unknown>>()).results ?? [];
  const normalizedPositions = (await env.DB.prepare(`SELECT p.*, s.source_id, s.as_of_date, s.captured_at, a.source_type, a.display_name
    FROM asset_positions p JOIN asset_snapshots s ON s.id=p.snapshot_id JOIN asset_sources a ON a.id=s.source_id
    ORDER BY s.as_of_date ASC, s.captured_at ASC`).all<Record<string, unknown>>()).results ?? [];
  const positionsBySnapshot = new Map<string, Record<string, unknown>[]>();
  for (const position of normalizedPositions) {
    const key = `${position.source_id}|${position.as_of_date}|${position.captured_at}`;
    const rows = positionsBySnapshot.get(key) ?? [];
    rows.push(position);
    positionsBySnapshot.set(key, rows);
  }
  for (const row of normalized) {
    const key = `${row.source_id}|${row.as_of_date}|${row.captured_at}`;
    const positions = positionsBySnapshot.get(key) ?? [];
    if (String(row.source_type).toLowerCase() === "wallet") {
      snapshots.push({
        wallet_id: row.source_id,
        wallet_name: row.display_name,
        address: row.public_address,
        as_of_date: row.as_of_date,
        captured_at: row.captured_at,
        fx_usdjpy: row.fx_usdjpy,
        total_usd: row.total_usd,
        total_jpy: row.total_jpy,
        tokens: positions.map((position) => ({
          symbol: position.symbol,
          amount_value: position.quantity,
          // The original browser client reads usd_value_display. Keep both
          // names so the legacy renderer and the normalized API agree.
          usd_value_display: position.value_usd,
          usd_value: position.value_usd,
        })),
      });
    } else {
      exchangeSnapshots.push({
        source_id: row.source_id,
        account_name: row.display_name,
        as_of_date: row.as_of_date,
        captured_at: row.captured_at,
        fx_usdjpy: row.fx_usdjpy,
        totals: { net_asset_usd: row.total_usd, net_asset_jpy: row.total_jpy },
        positions: positions.map((position) => ({
          symbol: position.symbol,
          quantity: position.quantity,
          usd_value: position.value_usd,
          account_type: position.protocol,
          is_liability: Boolean(position.is_debt),
        })),
      });
    }
  }
  // A launchd retry can leave both a legacy-import row and a normalized row
  // for the same source/date. The charts must use exactly one, newest record
  // per source and date; otherwise today's stETH balance is multiplied.
  const newestWallets = new Map<string, Record<string, unknown>>();
  for (const row of snapshots) {
    const key = `${String(row.wallet_id ?? "")}|${String(row.as_of_date ?? "").slice(0, 10)}`;
    const previous = newestWallets.get(key);
    if (key !== "|" && (!previous || String(row.captured_at ?? "") > String(previous.captured_at ?? ""))) newestWallets.set(key, row);
  }
  const newestExchanges = new Map<string, Record<string, unknown>>();
  for (const row of exchangeSnapshots) {
    const key = `${String(row.source_id ?? "")}|${String(row.as_of_date ?? "").slice(0, 10)}`;
    const previous = newestExchanges.get(key);
    if (key !== "|" && (!previous || String(row.captured_at ?? "") > String(previous.captured_at ?? ""))) newestExchanges.set(key, row);
  }
  snapshots = [...newestWallets.values()].sort((a, b) => String(a.as_of_date ?? "").localeCompare(String(b.as_of_date ?? "")));
  exchangeSnapshots = [...newestExchanges.values()].sort((a, b) => String(a.as_of_date ?? "").localeCompare(String(b.as_of_date ?? "")));
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
