/** History rows cut down to what the per-currency history reads.
 *
 *  A full history row carries everything the collector captured -- addresses,
 *  chain lists, display strings, raw parser output. The currency view reads far
 *  less of it: it turns a row into positions (manage-asset-core's walletPositions /
 *  exchangePositions, via currencyHistory) and looks at each position's symbol,
 *  quantity and USD value, plus the row's ids, dates, FX rate and total. On
 *  production a 90-day window is 896KB in full and ~480KB cut down like this.
 *
 *  These functions mirror those readers field by field. Wherever a reader falls
 *  back through several names with `??` (amount_value ?? amount_display ??
 *  quantity, usd_value_display ?? usd_value, ...), the first one present is
 *  emitted under the primary name, so the reader ends up with exactly the value it
 *  would have picked. tests/manage-asset-history-fields.test.mjs holds the two
 *  together: for the same rows, currencyHistory, stethRewardHistory,
 *  historyPoints and previousOpeningPoint must give identical results. If a reader
 *  in manage-asset-core.ts starts using another field, that test fails until it is
 *  added here.
 *
 *  Pure and dependency-free, so it runs under the plain-Node test project. */

type Row = Record<string, unknown>;
const list = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

/** A wallet snapshot row (wallet_id, tokens, DeFi protocols). */
export function currencyWalletRow(row: Row): Row {
  return {
    wallet_id: row.wallet_id,
    wallet_name: row.wallet_name,
    as_of_date: row.as_of_date,
    captured_at: row.captured_at,
    fx_usdjpy: row.fx_usdjpy,
    total_usd: row.total_usd,
    tokens: list(row.tokens).map((token) => ({
      symbol: token.symbol,
      amount_value: token.amount_value ?? token.amount_display ?? token.quantity,
      usd_value_display: token.usd_value_display ?? token.usd_value,
    })),
    protocols: list(row.protocols).map((protocol) => ({
      name: protocol.name ?? protocol.protocol_name,
      panels: list(protocol.panels).map((panel) => {
        const assets = list(panel.assets);
        // A panel without structured assets is read from its display text; with them, the text is never read.
        if (!assets.length) return { assets: [], display_text: panel.display_text };
        return {
          assets: assets.map((asset) => ({
            asset_symbol: asset.asset_symbol ?? asset.balance_token_symbol ?? asset.symbol,
            amount_value: asset.amount_value ?? asset.amount_display ?? asset.quantity,
            usd_value: asset.usd_value ?? asset.usd_value_display,
          })),
        };
      }),
    })),
  };
}

/** An exchange snapshot row (source_id, positions). */
export function currencyExchangeRow(row: Row): Row {
  return {
    source_id: row.source_id,
    account_name: row.account_name ?? row.display_name,
    as_of_date: row.as_of_date,
    captured_at: row.captured_at,
    fx_usdjpy: row.fx_usdjpy,
    totals: { net_asset_usd: (row.totals as Row | undefined)?.net_asset_usd },
    positions: list(row.positions).map((position) => ({
      symbol: position.symbol,
      net_quantity: position.net_quantity ?? position.quantity ?? position.amount,
      usd_value: position.usd_value ?? position.value_usd ?? position.usdValue,
      is_liability: position.is_liability ?? position.isDebt,
      account_type: position.account_type ?? position.protocol,
    })),
  };
}

export function currencyFields(history: { snapshots: Row[]; exchange_snapshots: Row[] }) {
  return { snapshots: history.snapshots.map(currencyWalletRow), exchange_snapshots: history.exchange_snapshots.map(currencyExchangeRow) };
}
