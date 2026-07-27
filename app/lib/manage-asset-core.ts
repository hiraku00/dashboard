export type AssetRow = Record<string, unknown>;

export type NormalizedPosition = {
  symbol: string;
  quantity: number | null;
  valueUsd: number;
  location: string;
  locationType: string;
  protocol: string;
  positionType: string;
  unpriced: boolean;
};

export type Holding = {
  symbol: string;
  quantity: number;
  quantityKnown: boolean;
  valueUsd: number;
  locations: string[];
  unitPriceUsd: number | null;
  unpriced: number;
};

const number = (value: unknown) => {
  const parsed = Number(String(value ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const quantity = (value: unknown): number | null => {
  const text = String(value ?? "").replace(/[$,\s]/g, "");
  if (!text || text.startsWith("<")) return text.startsWith("<") ? 0 : null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};

const latest = (rows: AssetRow[], key: string) => {
  const result = new Map<string, AssetRow>();
  for (const row of rows) {
    const id = String(row[key] ?? "");
    if (!id) continue;
    const previous = result.get(id);
    if (!previous || String(row.captured_at ?? row.capturedAt ?? "") > String(previous.captured_at ?? previous.capturedAt ?? "")) result.set(id, row);
  }
  return [...result.values()];
};

const latestPerSourceDate = (rows: AssetRow[], key: string) => {
  const result = new Map<string, AssetRow>();
  for (const row of rows) {
    const id = String(row[key] ?? "");
    const date = String(row.as_of_date ?? "").slice(0, 10);
    if (!id || !date) continue;
    const recordKey = `${id}|${date}`;
    const previous = result.get(recordKey);
    if (!previous || String(row.captured_at ?? "") > String(previous.captured_at ?? "")) result.set(recordKey, row);
  }
  return [...result.values()];
};

export function legacyDeFiAsset(panel: AssetRow): Pick<NormalizedPosition, "symbol" | "quantity" | "valueUsd" | "unpriced"> | null {
  const text = String(panel.display_text ?? "").replace(/\s+/g, " ");
  const match = text.match(/USD\s+Value\s+([A-Za-z0-9._-]+)\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s+([A-Za-z0-9._-]+)[\s\S]*?\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  const alternate = text.match(/USD\s+Value\s+([A-Za-z0-9._-]+)\s+([A-Za-z0-9._-]+)\s+([0-9][0-9,]*(?:\.[0-9]+)?)[\s\S]*?\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (match) return { symbol: match[1], quantity: quantity(match[2]), valueUsd: number(match[4]), unpriced: false };
  if (alternate) return { symbol: alternate[1], quantity: quantity(alternate[3]), valueUsd: number(alternate[4]), unpriced: false };
  return null;
}

export function walletPositions(records: AssetRow[]) {
  const positions: NormalizedPosition[] = [];
  for (const record of latest(records, "wallet_id")) {
    const location = String(record.wallet_name ?? record.name ?? record.address ?? "ウォレット");
    for (const token of Array.isArray(record.tokens) ? record.tokens as AssetRow[] : []) {
      const value = token.usd_value_display ?? token.usd_value;
      positions.push({ symbol: String(token.symbol ?? "資産不明"), quantity: quantity(token.amount_value ?? token.amount_display ?? token.quantity), valueUsd: number(value), location, locationType: "wallet", protocol: "", positionType: "asset", unpriced: value == null });
    }
    for (const protocol of Array.isArray(record.protocols) ? record.protocols as AssetRow[] : []) {
      const protocolName = String(protocol.name ?? protocol.protocol_name ?? "DeFi");
      for (const panel of Array.isArray(protocol.panels) ? protocol.panels as AssetRow[] : []) {
        const assets = Array.isArray(panel.assets) ? panel.assets as AssetRow[] : [];
        if (assets.length) {
          for (const asset of assets) {
            const value = asset.usd_value ?? asset.usd_value_display;
            positions.push({ symbol: String(asset.asset_symbol ?? asset.balance_token_symbol ?? asset.symbol ?? "資産不明"), quantity: quantity(asset.amount_value ?? asset.amount_display ?? asset.quantity), valueUsd: number(value), location, locationType: "defi", protocol: protocolName, positionType: "asset", unpriced: value == null });
          }
        } else {
          const parsed = legacyDeFiAsset(panel);
          if (parsed) positions.push({ ...parsed, location, locationType: "defi", protocol: protocolName, positionType: "asset" });
        }
      }
    }
  }
  return positions;
}

export function exchangePositions(records: AssetRow[]) {
  const positions: NormalizedPosition[] = [];
  for (const record of latest(records, "source_id")) {
    const location = String(record.account_name ?? record.display_name ?? record.source_id ?? "取引所");
    for (const position of Array.isArray(record.positions) ? record.positions as AssetRow[] : []) {
      const value = number(position.usd_value ?? position.value_usd ?? position.usdValue);
      positions.push({ symbol: String(position.symbol ?? "資産不明"), quantity: quantity(position.net_quantity ?? position.quantity ?? position.amount), valueUsd: Boolean(position.is_liability ?? position.isDebt) ? -value : value, location, locationType: "exchange", protocol: String(position.account_type ?? position.protocol ?? ""), positionType: Boolean(position.is_liability ?? position.isDebt) ? "debt" : "asset", unpriced: position.usd_value == null && position.value_usd == null && position.usdValue == null });
    }
  }
  return positions;
}

export function normalizeSyncedPositions(source: AssetRow, snapshot: AssetRow, supplied: AssetRow[]) {
  const sourceType = String(source.sourceType ?? source.source_type ?? "").toLowerCase();
  if (sourceType === "wallet" || snapshot.wallet_id || Array.isArray(snapshot.protocols)) return walletPositions([{ ...snapshot, wallet_id: snapshot.wallet_id ?? source.sourceId ?? source.id, wallet_name: snapshot.wallet_name ?? source.displayName ?? source.name, address: snapshot.address ?? source.publicAddress ?? source.address }]);
  return exchangePositions([{ ...snapshot, source_id: snapshot.source_id ?? source.sourceId ?? source.id, account_name: snapshot.account_name ?? source.displayName ?? source.name, positions: Array.isArray(snapshot.positions) ? snapshot.positions : supplied }]);
}

export function holdingsFromPositions(positions: NormalizedPosition[]): Holding[] {
  const grouped = new Map<string, { symbol: string; quantity: number; quantityKnown: boolean; valueUsd: number; locations: Map<string, number>; unpriced: number }>();
  for (const position of positions) {
    const item = grouped.get(position.symbol) ?? { symbol: position.symbol, quantity: 0, quantityKnown: false, valueUsd: 0, locations: new Map(), unpriced: 0 };
    item.valueUsd += position.valueUsd;
    if (position.quantity != null) { item.quantity += position.quantity; item.quantityKnown = true; }
    item.locations.set(position.location, (item.locations.get(position.location) ?? 0) + position.valueUsd);
    if (position.unpriced) item.unpriced += 1;
    grouped.set(position.symbol, item);
  }
  return [...grouped.values()].map((item) => ({ symbol: item.symbol, quantity: item.quantity, quantityKnown: item.quantityKnown, valueUsd: item.valueUsd, locations: [...item.locations.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name), unitPriceUsd: item.quantityKnown && item.quantity > 0 && item.valueUsd > 0 ? item.valueUsd / item.quantity : null, unpriced: item.unpriced })).sort((a, b) => b.valueUsd - a.valueUsd);
}

export function historyPoints(wallets: AssetRow[], exchanges: AssetRow[]) {
  const newest = new Map<string, AssetRow>();
  for (const row of wallets) {
    const key = `wallet:${row.wallet_id}|${row.as_of_date}`;
    const old = newest.get(key);
    if (!old || String(row.captured_at) > String(old.captured_at)) newest.set(key, row);
  }
  for (const row of exchanges) {
    const key = `exchange:${row.source_id}|${row.as_of_date}`;
    const old = newest.get(key);
    if (!old || String(row.captured_at) > String(old.captured_at)) newest.set(key, row);
  }
  const totals = new Map<string, number>();
  for (const row of newest.values()) {
    const date = String(row.as_of_date ?? "").slice(0, 10);
    if (!date) continue;
    totals.set(date, (totals.get(date) ?? 0) + number(row.total_usd ?? (row.totals as AssetRow | undefined)?.net_asset_usd));
  }
  return [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value }));
}

export function currencyHistory(wallets: AssetRow[], exchanges: AssetRow[], symbol: string, rates: AssetRow[]) {
  const records = [...latestPerSourceDate(wallets, "wallet_id"), ...latestPerSourceDate(exchanges, "source_id")];
  const fxByDate = new Map(rates.map((row) => [String(row.date ?? "").slice(0, 10), number(row.rate)]));
  const totals = new Map<string, { quantity: number; valueUsd: number; fx: number | null }>();
  for (const record of records) {
    const date = String(record.as_of_date ?? "").slice(0, 10);
    if (!date) continue;
    const positions = record.wallet_id ? walletPositions([record]) : exchangePositions([record]);
    const item = totals.get(date) ?? { quantity: 0, valueUsd: 0, fx: null };
    for (const position of positions) if (position.symbol.toLowerCase() === symbol.toLowerCase()) { item.quantity += position.quantity ?? 0; item.valueUsd += position.valueUsd; }
    const ownFx = number(record.fx_usdjpy);
    item.fx = item.fx ?? (ownFx || fxByDate.get(date) || null);
    totals.set(date, item);
  }
  const rows = [...totals.entries()].filter(([, item]) => item.quantity !== 0).sort((a, b) => a[0].localeCompare(b[0]));
  return rows.map(([date, item], index) => {
    const previous = index ? rows[index - 1][1].quantity : null;
    const delta = previous == null ? null : item.quantity - previous;
    const price = item.quantity ? item.valueUsd / item.quantity : null;
    const changeUsd = delta == null || price == null ? null : delta * price;
    const fx = item.fx ?? fxByDate.get(date) ?? null;
    return { date, quantity: item.quantity, balance: item.quantity, delta, change: delta, valueUsd: item.valueUsd, balanceUsd: item.valueUsd, price, usd: changeUsd, fx, yen: changeUsd != null && fx ? changeUsd * fx : null, apr: previous ? (delta ?? 0) / previous * 365 * 100 : null, source: "snapshot" };
  });
}

export function stethRewardHistory(rewards: AssetRow[], wallets: AssetRow[], exchanges: AssetRow[], rates: AssetRow[]) {
  const rateByDate = new Map(rates.map((row) => [String(row.date ?? "").slice(0, 10), number(row.rate)]));
  const rewardsOnly = rewards.filter((row) => String(row.type ?? row.reward_type ?? "").toLowerCase() === "reward").map((row) => {
    const date = String(row.date ?? row.reward_date ?? "").slice(0, 10);
    const change = number(row.change);
    const usd = number(row.change_USD ?? row.change_usd);
    const balance = number(row.balance);
    const fx = rateByDate.get(date) ?? null;
    const price = change ? usd / change : null;
    return { date, change, usd, apr: number(row.apr), balance, price, fx, yen: fx ? usd * fx : null, balanceUsd: price == null ? null : balance * price, source: "csv" };
  }).filter((row) => row.date).sort((a, b) => a.date.localeCompare(b.date));
  const snapshots = currencyHistory(wallets, exchanges, "stETH", rates);
  const lastRewardDate = rewardsOnly.at(-1)?.date;
  const result = [...rewardsOnly];
  let previous = result.at(-1)?.balance ?? snapshots[0]?.balance ?? 0;
  for (const row of snapshots.filter((item) => !lastRewardDate || item.date > lastRewardDate)) {
    const change = row.balance - previous;
    const usd = row.price == null ? 0 : change * row.price;
    result.push({ date: row.date, change, usd, apr: previous ? change / previous * 365 * 100 : 0, balance: row.balance, price: row.price, fx: row.fx, yen: row.fx ? usd * row.fx : null, balanceUsd: row.balanceUsd, source: "snapshot" });
    previous = row.balance;
  }
  return result;
}
