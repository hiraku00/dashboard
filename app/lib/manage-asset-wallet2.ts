/** Manage Asset の「ウォレット2」（ダミーデータ）を、本番データから作る純関数。
 *
 *  ウォレット2は本番と同じ形式のデータを、通貨ごとの倍率で増やしたもの。画面では
 *  ウォレット1（本番）とウォレット2を切り替える。
 *  倍率は通貨の記号で決まる（DEMO_FACTORS、それ以外は100倍）。wstETH・WBTC も
 *  記号が違うので100倍。
 *
 *  掛けるもの: 数量と評価額（USD・JPY）。掛けないもの: 単価、為替レート、日付、APR。
 *  スナップショットの総額は「元の総額 + Σ(倍率−1)×各明細の評価額」で作り直す。
 *  明細を総額に足し直すのではなく差分だけを足すので、評価できていない明細や
 *  DeBank の整数丸めによる「総額と明細の差」は、本番と同じだけ残る。
 *
 *  同じ関数を、朝の同期（app/api/manage-asset/sync）と、過去分を一度だけ作る
 *  scripts/build-wallet2-history.mjs の両方が使う。D1 も cloudflare:workers も
 *  読まないので、tests/manage-asset-wallet2.test.mjs から直接テストできる。 */

type Row = Record<string, unknown>;

const DEMO_FACTORS: Record<string, number> = { steth: 8, btc: 15, usdt: 1000 };
const DEFAULT_FACTOR = 100;

/** 記号ごとの倍率。大文字・小文字と前後の空白は区別しない（"stETH" も "STETH" も8倍）。 */
export function demoFactor(symbol: unknown): number {
  return DEMO_FACTORS[String(symbol ?? "").trim().toLowerCase()] ?? DEFAULT_FACTOR;
}

/** manage-asset-core.ts の number() と同じ読み方（"$1,234.5" → 1234.5、読めなければ0）。 */
function parseNumber(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

const NUMBER_LIKE = /^(-?)(\$?)\s*(-?)([0-9][0-9,]*(?:\.([0-9]+))?)([eE][-+]?[0-9]+)?$/;

function groupThousands(integerPart: string): string {
  return integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `original` と同じ書き方（"$" の有無、桁区切り、小数の桁数、数値か文字列か）で `next` を書く。
 *  読めない値（"<0.0001"、空文字、null）は、そのまま返す -- 本番でも読めない値なので。 */
export function formatLike(original: unknown, next: number): unknown {
  if (typeof original === "number") return next;
  if (typeof original !== "string") return original;
  const match = original.trim().match(NUMBER_LIKE);
  if (!match) return original;
  const [, , dollar, signAfter, digits, fraction = "", exponent] = match;
  if (exponent) return String(next);
  const decimals = fraction.length;
  const absolute = Math.abs(next);
  // 末尾に何十桁も持つ取引所の値（"0.0694334858765977591920467098"）は、
  // 浮動小数点で表せる以上の桁を toFixed で作ると嘘の数字が並ぶので、普通に書く。
  let text = decimals > 15 ? String(absolute) : absolute.toFixed(decimals);
  if (digits.includes(",") || (dollar && absolute >= 1000)) {
    const [integerPart, fractionPart] = text.split(".");
    text = groupThousands(integerPart) + (fractionPart != null ? `.${fractionPart}` : "");
  }
  if (next >= 0) return `${dollar}${text}`;
  // 元の書き方が "$-5" なら "$-"、"-$5" なら "-$"。元が正の値なら "-$" にする。
  return signAfter ? `${dollar}-${text}` : `-${dollar}${text}`;
}

/** 数量・評価額1つに倍率を掛ける。書き方は元の値に合わせる。 */
export function scaleNumberLike(value: unknown, factor: number): unknown {
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return value * factor;
  if (typeof value !== "string" || !value.trim().match(NUMBER_LIKE)) return value;
  return formatLike(value, parseNumber(value.replace(/\s/g, "")) * factor);
}

/** 総額を「元の値 + 差分」に変える。元の書き方は保つ。 */
function addTo(value: unknown, delta: number): unknown {
  if (value == null || value === "") return value;
  if (typeof value === "string" && !value.trim().match(NUMBER_LIKE)) return value;
  return formatLike(value, parseNumber(value) + delta);
}

function scaleFields(item: Row, fields: readonly string[], factor: number): Row {
  const next: Row = { ...item };
  for (const field of fields) if (field in next) next[field] = scaleNumberLike(next[field], factor);
  return next;
}

const WALLET_AMOUNT_FIELDS = ["amount_value", "amount_display", "quantity", "usd_value", "usd_value_display"] as const;
const EXCHANGE_AMOUNT_FIELDS = [
  "quantity", "net_quantity", "available_quantity", "locked_quantity", "borrowed_quantity", "amount",
  "usd_value", "value_usd", "usdValue", "asset_usd_value", "liability_usd_value",
] as const;

/** ウォレットのトークン（tokens[]）1件。評価額は walletPositions() と同じく usd_value_display を先に読む。 */
function scaleWalletToken(token: Row): { item: Row; delta: number } {
  const factor = demoFactor(token.symbol);
  const value = parseNumber(token.usd_value_display ?? token.usd_value);
  return { item: scaleFields(token, WALLET_AMOUNT_FIELDS, factor), delta: (factor - 1) * value };
}

/** DeFi のパネルの資産（protocols[].panels[].assets[]）1件。記号と評価額の読み方は walletPositions() と同じ。 */
function scaleDeFiAsset(asset: Row): { item: Row; delta: number } {
  const factor = demoFactor(asset.asset_symbol ?? asset.balance_token_symbol ?? asset.symbol);
  const value = parseNumber(asset.usd_value ?? asset.usd_value_display);
  return { item: scaleFields(asset, WALLET_AMOUNT_FIELDS, factor), delta: (factor - 1) * value };
}

// manage-asset-core.ts の legacyDeFiAsset() と同じ2つの形。数量と評価額の位置（d フラグの indices）を使って、
// その部分の数字だけを書き換える（tsconfig の target が d フラグのリテラルを許さないので RegExp で作る）。
const PANEL_TEXT = new RegExp(/USD\s+Value\s+([A-Za-z0-9._-]+)\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s+([A-Za-z0-9._-]+)[\s\S]*?\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/.source, "di");
const PANEL_TEXT_ALTERNATE = new RegExp(/USD\s+Value\s+([A-Za-z0-9._-]+)\s+([A-Za-z0-9._-]+)\s+([0-9][0-9,]*(?:\.[0-9]+)?)[\s\S]*?\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/.source, "di");

/** 構造化された assets を持たない古いパネルは、display_text の文字から数量と評価額が読まれる。
 *  その2つの数字を倍率で書き換え、それ以外の文字はそのまま残す。 */
export function scalePanelText(text: string): { text: string; delta: number } {
  // legacyDeFiAsset() は空白を詰めてから読む。位置を合わせるため、同じく詰めた文字列を書き換える。
  const normalized = text.replace(/\s+/g, " ");
  const match = normalized.match(PANEL_TEXT);
  const alternate = match ? null : normalized.match(PANEL_TEXT_ALTERNATE);
  const found = match ?? alternate;
  if (!found?.indices) return { text, delta: 0 };
  const quantityGroup = match ? 2 : 3;
  const factor = demoFactor(found[1]);
  const value = parseNumber(found[4]);
  const replacements = [quantityGroup, 4]
    .map((group) => ({ range: found.indices![group]!, value: found[group], dollar: group === 4 }))
    .sort((a, b) => b.range[0] - a.range[0]);
  let next = normalized;
  for (const { range, value: original, dollar } of replacements) {
    // 評価額は "$" の後ろの数字だけが group に入る。"$" 付きとして書き（桁区切りを付け）、"$" を外して戻す。
    const scaled = dollar ? String(scaleNumberLike(`$${original}`, factor)).slice(1) : String(scaleNumberLike(original, factor));
    next = next.slice(0, range[0]) + scaled + next.slice(range[1]);
  }
  return { text: next, delta: (factor - 1) * value };
}

function scaleProtocols(protocols: unknown[]): { protocols: unknown[]; delta: number } {
  let total = 0;
  const next = protocols.map((protocol) => {
    if (!protocol || typeof protocol !== "object") return protocol;
    let protocolDelta = 0;
    const source = protocol as Row;
    const panels = Array.isArray(source.panels) ? source.panels.map((panel) => {
      if (!panel || typeof panel !== "object") return panel;
      const row = panel as Row;
      const assets = Array.isArray(row.assets) ? row.assets : [];
      if (assets.length) {
        const scaled = assets.map((asset) => {
          if (!asset || typeof asset !== "object") return asset;
          const { item, delta } = scaleDeFiAsset(asset as Row);
          protocolDelta += delta;
          return item;
        });
        return { ...row, assets: scaled };
      }
      if (typeof row.display_text !== "string") return row;
      const { text, delta } = scalePanelText(row.display_text);
      protocolDelta += delta;
      return { ...row, display_text: text };
    }) : source.panels;
    total += protocolDelta;
    return { ...source, ...(panels !== undefined ? { panels } : {}), ...("usd_value" in source ? { usd_value: addTo(source.usd_value, protocolDelta) } : {}) };
  });
  return { protocols: next, delta: total };
}

/** 取引所のポジション1件。負債は exchangePositions() と同じく評価額をマイナスに数える。 */
function scaleExchangePosition(position: Row): { item: Row; delta: number; assetDelta: number; liabilityDelta: number } {
  const factor = demoFactor(position.symbol);
  const value = parseNumber(position.usd_value ?? position.value_usd ?? position.usdValue);
  const liability = Boolean(position.is_liability ?? position.isDebt);
  return {
    item: scaleFields(position, EXCHANGE_AMOUNT_FIELDS, factor),
    delta: (factor - 1) * (liability ? -value : value),
    assetDelta: (factor - 1) * parseNumber(position.asset_usd_value ?? (liability ? 0 : value)),
    liabilityDelta: (factor - 1) * parseNumber(position.liability_usd_value ?? (liability ? value : 0)),
  };
}

/** USD の差分に見合う JPY の差分。レートがあればそれで、なければ USD の増え方の比で増やす。 */
function jpyAfter(jpy: unknown, usdBefore: number, deltaUsd: number, fx: unknown): unknown {
  const rate = parseNumber(fx);
  if (rate > 0) return addTo(jpy, deltaUsd * rate);
  if (usdBefore !== 0) return formatLike(jpy, parseNumber(jpy) * ((usdBefore + deltaUsd) / usdBefore));
  return jpy;
}

/** 1つの source・1日分のスナップショット（ウォレットの DeBank 形式 / 取引所の portfolio 形式のどちらも）。
 *
 *  同期 API の snapshot（collector の行に capturedAt / totalUsd などを足したもの）と、
 *  asset_history_records.payload_json の両方がこの形。持っているキーだけを書き換え、
 *  それ以外（日付、ID、名前、単価、レート、変化率）はそのまま残す。
 *  `address` はウォレット2用の偽のアドレスに置き換える。 */
export function scaleAssetRecord(record: Row): { record: Row; deltaUsd: number } {
  const next: Row = { ...record };
  let deltaUsd = 0;
  let assetDelta = 0;
  let liabilityDelta = 0;
  if (Array.isArray(record.tokens)) {
    next.tokens = record.tokens.map((token) => {
      if (!token || typeof token !== "object") return token;
      const { item, delta } = scaleWalletToken(token as Row);
      deltaUsd += delta;
      return item;
    });
  }
  if (Array.isArray(record.protocols)) {
    const { protocols, delta } = scaleProtocols(record.protocols);
    next.protocols = protocols;
    deltaUsd += delta;
  }
  if (Array.isArray(record.positions)) {
    next.positions = record.positions.map((position) => {
      if (!position || typeof position !== "object") return position;
      const scaled = scaleExchangePosition(position as Row);
      deltaUsd += scaled.delta;
      assetDelta += scaled.assetDelta;
      liabilityDelta += scaled.liabilityDelta;
      return scaled.item;
    });
  }
  const totals = record.totals && typeof record.totals === "object" ? record.totals as Row : null;
  const usdBefore = parseNumber(record.totalUsd ?? record.total_usd ?? totals?.net_asset_usd);
  const fx = record.fxUsdjpy ?? record.fx_usdjpy;
  if ("total_usd" in record) next.total_usd = addTo(record.total_usd, deltaUsd);
  if ("totalUsd" in record) next.totalUsd = addTo(record.totalUsd, deltaUsd);
  if ("total_jpy" in record) next.total_jpy = jpyAfter(record.total_jpy, usdBefore, deltaUsd, fx);
  if ("totalJpy" in record) next.totalJpy = jpyAfter(record.totalJpy, usdBefore, deltaUsd, fx);
  if (totals) {
    const nextTotals: Row = { ...totals };
    if ("net_asset_usd" in totals) nextTotals.net_asset_usd = addTo(totals.net_asset_usd, deltaUsd);
    if ("net_asset_jpy" in totals) nextTotals.net_asset_jpy = jpyAfter(totals.net_asset_jpy, parseNumber(totals.net_asset_usd), deltaUsd, fx);
    if ("gross_asset_usd" in totals) nextTotals.gross_asset_usd = addTo(totals.gross_asset_usd, assetDelta);
    if ("liability_usd" in totals) nextTotals.liability_usd = addTo(totals.liability_usd, liabilityDelta);
    next.totals = nextTotals;
  }
  // チェーン別の評価額は明細と結び付かないので、総額の増え方の比で増やす（画面では読まない）。
  if (Array.isArray(record.chains) && usdBefore > 0) {
    const ratio = (usdBefore + deltaUsd) / usdBefore;
    next.chains = record.chains.map((chain) => chain && typeof chain === "object" && "usd_value" in chain
      ? { ...(chain as Row), usd_value: formatLike((chain as Row).usd_value, parseNumber((chain as Row).usd_value) * ratio) }
      : chain);
  }
  if (typeof record.address === "string") next.address = wallet2Address(record.address);
  return { record: next, deltaUsd };
}

/** 同期 API の1 source 分（{ source, snapshot, positions }）をウォレット2用に変える。
 *  positions はウォレットなら snapshot.tokens の写し、取引所なら snapshot.positions の写しなので、
 *  同じ規則で掛ける。source の公開アドレスは偽のアドレスにする（取引所名はそのまま）。 */
export function scaleSyncEntry<T extends { source?: Row; snapshot?: Row; positions?: unknown[] }>(entry: T): T {
  const next = { ...entry };
  if (entry.source) {
    const source: Row = { ...entry.source };
    for (const key of ["publicAddress", "address"]) if (typeof source[key] === "string") source[key] = wallet2Address(source[key] as string);
    next.source = source;
  }
  if (entry.snapshot) next.snapshot = scaleAssetRecord(entry.snapshot).record;
  if (Array.isArray(entry.positions)) {
    next.positions = entry.positions.map((position) => {
      if (!position || typeof position !== "object") return position;
      const row = position as Row;
      // ウォレットの tokens[] と取引所の positions[] は持つキーが違うので、どちらの欄もあれば掛ける。
      return scaleFields(row, [...new Set([...WALLET_AMOUNT_FIELDS, ...EXCHANGE_AMOUNT_FIELDS])], demoFactor(row.symbol ?? row.asset_symbol ?? row.balance_token_symbol));
    });
  }
  return next;
}

/** D1 に保存済みの asset_positions 1行（過去分の作成用）。単価はそのまま。 */
export function scalePositionRow(row: Row): { row: Row; deltaUsd: number } {
  const factor = demoFactor(row.symbol);
  const value = Number(row.value_usd) || 0;
  return {
    row: { ...row, quantity: scaleNumberLike(row.quantity, factor), value_usd: scaleNumberLike(row.value_usd, factor), value_jpy: scaleNumberLike(row.value_jpy, factor) },
    deltaUsd: (factor - 1) * value,
  };
}

/** D1 に保存済みの asset_snapshots 1行の総額を、明細から出した差分で作り直す（過去分の作成用）。 */
export function scaleSnapshotTotals(row: Row, deltaUsd: number): Row {
  const usdBefore = Number(row.total_usd) || 0;
  return { ...row, total_usd: usdBefore + deltaUsd, total_jpy: jpyAfter(Number(row.total_jpy) || 0, usdBefore, deltaUsd, row.fx_usdjpy) };
}

const LIDO_AMOUNT_FIELDS = ["change", "change_USD", "change_usd", "balance", "balance_USD", "balance_usd"] as const;

/** Lido の報酬 CSV の1行（stETH なので8倍）。APR・日付・種類はそのまま。 */
export function scaleLidoReward(row: Row): Row {
  return scaleFields(row, LIDO_AMOUNT_FIELDS, demoFactor("stETH"));
}

/** 文字列から決まる 32bit の値（FNV-1a）。同じアドレスからは、いつも同じ偽のアドレスができる。 */
function fnv1a(text: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** ウォレット2で見せる、それらしい偽のアドレス。
 *
 *  本物のアドレスを見せると、チェーン上で実際の残高を調べられてしまうので、ウォレット2では
 *  全部これに置き換える。長さと形（"0x" の接頭辞、英数字の位置）は元と同じにし、文字だけを
 *  元のアドレスから決まる別の文字にする。同じアドレスは、朝の同期でも過去分でも同じ偽の
 *  アドレスになる（同じウォレットが日によって別のアドレスに見えないように）。 */
export function wallet2Address(address: string): string {
  if (!address) return address;
  const hexBody = /^0x[0-9a-fA-F]+$/.test(address);
  let state = fnv1a(`wallet2:${address.toLowerCase()}`);
  const nextValue = (index: number) => {
    state = fnv1a(String(index), state);
    return state;
  };
  return [...address].map((char, index) => {
    if (hexBody && index < 2) return char;
    if (hexBody || (/^[0-9a-f]+$/i.test(address) && /[0-9a-f]/i.test(char))) return (nextValue(index) % 16).toString(16);
    if (/[0-9]/.test(char)) return String(nextValue(index) % 10);
    if (/[a-z]/.test(char)) return String.fromCharCode(97 + (nextValue(index) % 26));
    if (/[A-Z]/.test(char)) return String.fromCharCode(65 + (nextValue(index) % 26));
    return char;
  }).join("");
}
