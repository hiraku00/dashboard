import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { exchangePositions, holdingsFromPositions, walletPositions } from "@/app/lib/manage-asset-core";

export async function GET() {
  await ensureSchema({ seed: false });
  const sources = (await env.DB.prepare("SELECT * FROM asset_sources WHERE enabled=1 ORDER BY display_name").all<Record<string, unknown>>()).results ?? [];
  const snapshotRows = (await env.DB.prepare("SELECT s.*, a.source_type, a.display_name, a.provider, a.public_address FROM asset_snapshots s JOIN asset_sources a ON a.id=s.source_id WHERE s.id IN (SELECT x.id FROM asset_snapshots x LEFT JOIN asset_sync_runs xr ON xr.id=x.run_id WHERE x.source_id=s.source_id ORDER BY COALESCE(xr.received_at, '') DESC, x.rowid DESC LIMIT 1) ORDER BY s.total_usd DESC").all<Record<string, unknown>>()).results ?? [];
  const history = (await env.DB.prepare("SELECT as_of_date, SUM(total_usd) AS total_usd, SUM(total_jpy) AS total_jpy FROM asset_snapshots GROUP BY as_of_date ORDER BY as_of_date DESC LIMIT 90").all<Record<string, unknown>>()).results ?? [];
  const runs = (await env.DB.prepare("SELECT * FROM asset_sync_runs ORDER BY received_at DESC LIMIT 20").all<Record<string, unknown>>()).results ?? [];
  const positions = (await env.DB.prepare(`SELECT p.*, a.display_name, a.provider FROM asset_positions p JOIN asset_snapshots s ON s.id=p.snapshot_id JOIN asset_sources a ON a.id=s.source_id WHERE s.id IN (SELECT x.id FROM asset_snapshots x LEFT JOIN asset_sync_runs xr ON xr.id=x.run_id WHERE x.source_id=s.source_id ORDER BY COALESCE(xr.received_at, '') DESC, x.rowid DESC LIMIT 1) ORDER BY p.value_usd DESC`).all<Record<string, unknown>>()).results ?? [];
  const positionsBySnapshot = new Map<string, Record<string, unknown>[]>();
  for (const position of positions) {
    const rows = positionsBySnapshot.get(String(position.snapshot_id)) ?? [];
    rows.push(position);
    positionsBySnapshot.set(String(position.snapshot_id), rows);
  }
  // Keep the response shape expected by the original Manage Asset frontend.
  // The normalized D1 tables use source_id/display_name for both source types,
  // while the original UI distinguishes wallet_id/wallet_name and
  // source_id/account_name.
  const snapshots = snapshotRows.filter((row) => String(row.source_type).toLowerCase() === "wallet").map((row) => ({
    wallet_id: row.source_id,
    wallet_name: row.display_name,
    address: row.public_address,
    as_of_date: row.as_of_date,
    captured_at: row.captured_at,
    fx_usdjpy: row.fx_usdjpy,
    total_usd: row.total_usd,
    total_jpy: row.total_jpy,
    tokens: (positionsBySnapshot.get(String(row.id)) ?? []).map((position) => ({
      symbol: position.symbol,
      amount_value: position.quantity,
      usd_value_display: position.value_usd,
    })),
  }));
  const exchangeSnapshots = snapshotRows.filter((row) => String(row.source_type).toLowerCase() !== "wallet").map((row) => ({
    source_id: row.source_id,
    account_name: row.display_name,
    as_of_date: row.as_of_date,
    captured_at: row.captured_at,
    fx_usdjpy: row.fx_usdjpy,
    totals: { net_asset_usd: row.total_usd, net_asset_jpy: row.total_jpy },
    positions: (positionsBySnapshot.get(String(row.id)) ?? []).map((position) => ({
      symbol: position.symbol,
      quantity: position.quantity,
      net_quantity: position.quantity,
      usd_value: position.value_usd,
      is_liability: Boolean(position.is_debt),
      account_type: position.protocol,
    })),
  }));
  const directHoldings = Object.values(positions.reduce<Record<string, Record<string, unknown>>>((acc, row) => { const key=String(row.symbol); const item=acc[key]??={symbol:key,quantity:0,value_usd:0,value_jpy:0,locations:[]}; item.quantity=Number(item.quantity)+Number(row.quantity??0); item.value_usd=Number(item.value_usd)+Number(row.value_usd??0); item.value_jpy=Number(item.value_jpy)+Number(row.value_jpy??0); (item.locations as Array<Record<string,unknown>>).push(row); return acc; }, {}));
  // Older portal syncs stored only wallet tokens. Use the imported raw history
  // as a read-only fallback until the next normalized sync replaces the source.
  const rawRecords = (await env.DB.prepare("SELECT record_type,payload_json FROM asset_history_records ORDER BY as_of_date ASC,captured_at ASC").all<{ record_type: string; payload_json: string }>()).results ?? [];
  const wallets = rawRecords.filter((row) => row.record_type === "wallet").map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
  const exchanges = rawRecords.filter((row) => row.record_type === "exchange").map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
  const fallback = holdingsFromPositions([...walletPositions(wallets), ...exchangePositions(exchanges)]);
  const combined = new Map(directHoldings.map((row) => [String(row.symbol), row]));
  for (const row of fallback) if (!combined.has(row.symbol)) combined.set(row.symbol, { symbol: row.symbol, quantity: row.quantity, value_usd: row.valueUsd, value_jpy: 0, unit_price_usd: row.unitPriceUsd, locations: row.locations.map((display_name) => ({ display_name })) });
  const holdings = [...combined.values()].sort((a,b)=>Number(b.value_usd)-Number(a.value_usd));
  const walletsConfig = sources
    .filter((source) => String(source.source_type).toLowerCase() === "wallet")
    .map((source) => ({
      wallet_id: source.id,
      name: source.display_name,
      address: source.public_address,
      enabled: Boolean(source.enabled),
    }));
  const exchangeSources = sources
    .filter((source) => String(source.source_type).toLowerCase() !== "wallet")
    .map((source) => ({
      ...source,
      source_id: source.id,
      credential_configured: true,
    }));
  return Response.json({
    sources: exchangeSources,
    wallets: walletsConfig,
    snapshots,
    exchange_snapshots: exchangeSnapshots,
    history,
    runs,
    positions,
    holdings,
    daily_update: { errors: {} },
  });
}
