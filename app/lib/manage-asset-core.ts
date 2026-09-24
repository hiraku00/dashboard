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

/** wallet + exchange のポジションを結合する（portfolio-core.js の allPositions）。
 *  保管場所の内訳表示や reconciliation の明細合計で使う。 */
export function allPositions(wallets: AssetRow[], exchanges: AssetRow[]): NormalizedPosition[] {
  return [...walletPositions(wallets), ...exchangePositions(exchanges)];
}

/** 総資産（USD）。各 source の最新スナップショットが持つ総額を合算する。
 *  ポジション明細の合計（reconciliation.detail）ではなく、スナップショットが
 *  申告した総額を正とする -- 明細に評価漏れがあっても総額は崩れない。 */
export function total(wallets: AssetRow[], exchanges: AssetRow[]): number {
  return (
    latest(wallets, "wallet_id").reduce((sum, row) => sum + number(row.total_usd), 0) +
    latest(exchanges, "source_id").reduce((sum, row) => sum + number((row.totals as AssetRow | undefined)?.net_asset_usd), 0)
  );
}

export type LocationSummary = {
  id: unknown;
  name: string;
  type: string;
  value: number;
  captured_at: unknown;
  as_of_date: unknown;
  status: string;
};

/** 保管場所ごとの評価額と鮮度。`today` と as_of_date がズレていれば「古いデータ」。 */
export function locations(wallets: AssetRow[], exchanges: AssetRow[], today: string): LocationSummary[] {
  return [
    ...latest(wallets, "wallet_id").map((row) => ({
      id: row.wallet_id,
      name: String(row.wallet_name ?? row.address ?? ""),
      type: "ウォレット",
      value: number(row.total_usd),
      captured_at: row.captured_at,
      as_of_date: row.as_of_date,
      status: today && row.as_of_date !== today ? "古いデータ" : "最新",
    })),
    ...latest(exchanges, "source_id").map((row) => ({
      id: row.source_id,
      name: String(row.account_name ?? ""),
      type: "取引所",
      value: number((row.totals as AssetRow | undefined)?.net_asset_usd),
      captured_at: row.captured_at,
      as_of_date: row.as_of_date,
      status: (row.quality as AssetRow | undefined)?.warnings != null && Array.isArray((row.quality as AssetRow).warnings) && ((row.quality as AssetRow).warnings as unknown[]).length
        ? "一部未評価"
        : today && row.as_of_date !== today ? "古いデータ" : "最新",
    })),
  ].sort((a, b) => b.value - a.value);
}

export type ReconciliationSource = { kind: string; id: unknown; name: string; expected: number; detail: number; difference: number };
export type Reconciliation = { sources: ReconciliationSource[]; issues: ReconciliationSource[]; total: number; detail: number };

/** 総額と明細の差をどこまで丸め誤差として許すか（USD）。ウォレットの総額は DeBank の
 *  ヘッダー表示をそのまま読むため、残高が数ドル以下だと整数に丸められる（例: 明細合計
 *  0.49 に対し総額 "$1"）。整数丸めの誤差は最大 0.5 なので、0.5 ちょうどでは
 *  0.5 を跨いだ日に誤検知する。 */
const RECONCILIATION_TOLERANCE_USD = 1;

/** 申告総額（expected）とポジション明細の合計（detail）を source ごとに突き合わせ、
 *  RECONCILIATION_TOLERANCE_USD を超える差がある source を issues として返す。 */
export function reconciliation(wallets: AssetRow[], exchanges: AssetRow[]): Reconciliation {
  const rows = [
    ...latest(wallets, "wallet_id").map((row) => ({ kind: "wallet", id: row.wallet_id, name: String(row.wallet_name ?? row.address ?? ""), expected: number(row.total_usd), positions: walletPositions([row]) })),
    ...latest(exchanges, "source_id").map((row) => ({ kind: "exchange", id: row.source_id, name: String(row.account_name ?? ""), expected: number((row.totals as AssetRow | undefined)?.net_asset_usd), positions: exchangePositions([row]) })),
  ];
  const sources = rows.map((row) => {
    const detail = row.positions.reduce((sum, position) => sum + position.valueUsd, 0);
    return { kind: row.kind, id: row.id, name: row.name, expected: row.expected, detail, difference: row.expected - detail };
  });
  const issues = sources.filter((row) => Math.abs(row.difference) > RECONCILIATION_TOLERANCE_USD + 1e-9);
  return { sources, issues, total: sources.reduce((sum, row) => sum + row.expected, 0), detail: sources.reduce((sum, row) => sum + row.detail, 0) };
}

/** 最新スナップショット由来の USD/JPY レート。captured_at が最も新しく fx_usdjpy を
 *  持つ行を採用する（app-ui.js の fxInfo と同じ）。資産概要の円換算・前日比の円額に使う。 */
export function latestFx(wallets: AssetRow[], exchanges: AssetRow[]): { rate: number; at: unknown } | null {
  const rows = [...wallets, ...exchanges].filter((row) => row.fx_usdjpy);
  if (!rows.length) return null;
  const row = rows.slice().sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at))).at(-1)!;
  return { rate: Number(row.fx_usdjpy), at: row.captured_at };
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

/** 資産概要の「前日保存比」の基準となる、直近スナップショット日より前で最も新しい
 *  記録日の総額。その日の各 source について captured_at が最も早い（＝その日の
 *  始値相当の）行を採り、合算する（app-ui.js が渡す history 全体を対象にする）。
 *  fx はその行のうち captured_at が最も新しい fx_usdjpy 持ちの行のレート（無ければ null）。 */
export function previousOpeningPoint(wallets: AssetRow[], exchanges: AssetRow[], latestDate: string | null): { date: string; value: number; fx: number | null } | null {
  const tag = (row: AssetRow, sourceKey: string): AssetRow & { sourceKey: string } => ({ ...row, sourceKey });
  const rows = [
    ...wallets.map((row) => tag(row, `wallet:${row.wallet_id}`)),
    ...exchanges.map((row) => tag(row, `exchange:${row.source_id}`)),
  ].filter((row) => row.as_of_date && (!latestDate || String(row.as_of_date) < latestDate));
  if (!rows.length) return null;
  const date = rows.map((row) => String(row.as_of_date)).sort().at(-1)!;
  const earliest = new Map<string, AssetRow>();
  for (const row of rows.filter((item) => String(item.as_of_date) === date)) {
    const old = earliest.get(row.sourceKey);
    if (!old || String(row.captured_at) < String(old.captured_at)) earliest.set(row.sourceKey, row);
  }
  const picked = [...earliest.values()];
  const fxRow = picked.filter((row) => row.fx_usdjpy).sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at))).at(-1);
  return { date, value: picked.reduce((sum, row) => sum + number(row.total_usd ?? (row.totals as AssetRow | undefined)?.net_asset_usd), 0), fx: fxRow ? Number(fxRow.fx_usdjpy) : null };
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

/** snapshotStartDate は portfolio-core.js の第4引数（移行境界日）と同じ役割。
 *  CSV の最終日より後、かつこの日付以降のスナップショットだけを継ぎ足す --
 *  CSV が境界日より前で途切れていても、境界日までの間を誤って埋めない。 */
export function stethRewardHistory(rewards: AssetRow[], wallets: AssetRow[], exchanges: AssetRow[], rates: AssetRow[], snapshotStartDate?: string) {
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
  for (const row of snapshots.filter((item) => (!lastRewardDate || item.date > lastRewardDate) && (!snapshotStartDate || item.date >= snapshotStartDate))) {
    const change = row.balance - previous;
    const usd = row.price == null ? 0 : change * row.price;
    result.push({ date: row.date, change, usd, apr: previous ? change / previous * 365 * 100 : 0, balance: row.balance, price: row.price, fx: row.fx, yen: row.fx ? usd * row.fx : null, balanceUsd: row.balanceUsd, source: "snapshot" });
    previous = row.balance;
  }
  return result;
}
