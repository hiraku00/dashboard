/** Maps a normalized asset_snapshots row (joined with its source) into the
 *  shape the original Manage Asset frontend expects.
 *
 *  The normalized D1 tables use source_id/display_name for both source types,
 *  while the original UI distinguishes wallet_id/wallet_name from
 *  source_id/account_name. /api/manage-asset/state and
 *  /api/manage-asset/history both have to produce that shape, and both had
 *  their own copy of this mapping -- which had already drifted: state's wallet
 *  tokens omitted usd_value (history emitted both names), and history's
 *  exchange positions omitted net_quantity (state emitted it). Neither
 *  difference was deliberate, and consumers read these two endpoints
 *  interchangeably, so both mappers emit every name here.
 *
 *  sync_received_at is passed through when the caller's query selected it.
 *  history needs it to pick the newest record per source and date after
 *  merging normalized rows with the legacy asset_history_records import;
 *  state resolves "latest per source" in SQL and leaves the field absent, as
 *  it always has. */

type Row = Record<string, unknown>;

export function toLegacyWalletSnapshot(row: Row, positions: Row[]) {
  return {
    wallet_id: row.source_id,
    wallet_name: row.display_name,
    address: row.public_address,
    as_of_date: row.as_of_date,
    captured_at: row.captured_at,
    sync_received_at: row.sync_received_at,
    fx_usdjpy: row.fx_usdjpy,
    total_usd: row.total_usd,
    total_jpy: row.total_jpy,
    tokens: positions.map((position) => ({
      symbol: position.symbol,
      amount_value: position.quantity,
      // The original browser client reads usd_value_display; the normalized
      // API path reads usd_value. Emit both so neither has to know.
      usd_value_display: position.value_usd,
      usd_value: position.value_usd,
    })),
  };
}

export function toLegacyExchangeSnapshot(row: Row, positions: Row[]) {
  return {
    source_id: row.source_id,
    account_name: row.display_name,
    as_of_date: row.as_of_date,
    captured_at: row.captured_at,
    sync_received_at: row.sync_received_at,
    fx_usdjpy: row.fx_usdjpy,
    totals: { net_asset_usd: row.total_usd, net_asset_jpy: row.total_jpy },
    positions: positions.map((position) => ({
      symbol: position.symbol,
      quantity: position.quantity,
      // exchangePositions() in manage-asset-core.ts reads net_quantity first
      // and falls back to quantity, so both are the same value here.
      net_quantity: position.quantity,
      usd_value: position.value_usd,
      is_liability: Boolean(position.is_debt),
      account_type: position.protocol,
    })),
  };
}
