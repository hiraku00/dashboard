import { expect, test } from "vitest";

import { currencyExchangeRow, currencyFields, currencyWalletRow } from "../app/lib/manage-asset-history-fields.ts";
import { currencyHistory, historyPoints, previousOpeningPoint, stethRewardHistory, walletPositions, exchangePositions } from "../app/lib/manage-asset-core.ts";

// The per-currency history reads a fraction of a full history row. currencyFields()
// cuts rows down to that fraction, so the one thing that matters is that the
// readers give the SAME answer on the cut-down rows. Every case below runs the
// real readers on the full rows and on the cut-down rows and requires identical
// output; the data is built to walk the readers' fallbacks (`a ?? b ?? c`), string
// numbers, liabilities, and the DeFi panels read from text.

const CUTOVER = "2026-07-12";

// ---- wallet rows: one field name per fallback position, on different tokens ----
const wallet = (date, over = {}) => ({
  schema_version: 3, record_type: "wallet", run_id: "r", wallet_id: "w1", wallet_name: "Lido2", address: "0xabc", source: "debank", input_sha256: "deadbeef", parser_version: "1",
  as_of_date: date, captured_at: `${date}T02:00:00Z`, fx_usdjpy: 150, total_usd: 9000, change_display: "+1%", chains: [{ id: "eth", name: "Ethereum" }],
  tokens: [
    { symbol: "stETH", amount_value: 3, usd_value_display: "$9,000.00", price_display: "$3000", amount_display: "3.0", asset_ref: "/token/eth/0x" },
    { symbol: "ETH", amount_display: "1,234.5", usd_value: 3703500, quantity: 99 },          // amount_value absent -> amount_display; usd_value_display absent -> usd_value
    { symbol: "DUST", quantity: "<0.01", usd_value_display: "$0.01" },                        // "<0.01" reads as 0
    { symbol: "NOPRICE", amount_value: 5 },                                                   // no value at all
    { amount_value: 1, usd_value_display: "$1.00" },                                          // no symbol -> the reader's default
    { symbol: "PREF", amount_value: 2, amount_display: "999", usd_value_display: "$2", usd_value: 999 }, // the first name wins
  ],
  protocols: [
    { name: "Aave", protocol_name: "ignored", panels: [
      { assets: [{ asset_symbol: "aWETH", amount_value: 2, usd_value: 6000, usd_value_display: "$1", balance_token_symbol: "x", symbol: "y" }, { balance_token_symbol: "BAL", amount_display: "4", usd_value_display: "$40" }, { symbol: "PLAIN", quantity: 7, usd_value: 70 }], display_text: "never read" },
      { assets: [], display_text: "USD Value stETH 1.5 stETH $4,500.00" },                  // no structured assets -> read from text
      { display_text: "USD Value USDC 250 USDC $250" },                                       // assets absent altogether
    ] },
    { protocol_name: "Curve", panels: [{ assets: [{ asset_symbol: "crvUSD", amount_value: "10", usd_value: "$10" }] }] },
    { panels: [] },
  ],
  ...over,
});
const exchange = (date, over = {}) => ({
  schema_version: 2, record_type: "exchange", snapshot_id: "s", run_id: "r", source_id: "x1", source_type: "exchange", provider: "p", account_id: "a", account_name: "Binance", captured_at: `${date}T02:30:00Z`, effective_at: `${date}T02:30:00Z`, as_of_date: date, status: "ok", valuation_currency: "USD", fx_usdjpy: 151,
  connector: { id: "c" }, quality: { ok: true },
  positions: [
    { symbol: "BTC", net_quantity: 0.5, quantity: 9, usd_value: 30000, value_usd: 1, is_liability: false, account_type: "spot" },
    { symbol: "ETH", quantity: 2, value_usd: 6000, protocol: "earn" },                        // net_quantity absent -> quantity; usd_value absent -> value_usd; account_type absent -> protocol
    { symbol: "USDT", amount: 100, usdValue: 100 },                                           // amount / usdValue aliases
    { symbol: "JPY", quantity: -50, value_usd: 50, isDebt: true, account_type: "margin" },    // a liability by the other name
    { symbol: "BNB", net_quantity: 1, usd_value: 600, is_liability: true },                   // a liability by the primary name
    { quantity: 1, usd_value: 1 },                                                            // no symbol
  ],
  totals: { net_asset_usd: 36700, net_asset_jpy: 5500000, gross: 1 },
  ...over,
});

const dates = ["2026-07-11", "2026-07-15", "2026-08-01", "2026-09-01", "2026-09-20", "2026-09-21"];
const richHistory = () => ({
  snapshots: [
    ...dates.map((d, i) => wallet(d, { total_usd: 9000 + i, tokens: wallet(d).tokens.map((t) => (t.symbol === "stETH" ? { ...t, amount_value: 3 + i * 0.01 } : t)) })),
    wallet("2026-09-21", { captured_at: "2026-09-21T09:00:00Z", total_usd: 8999 }), // a second capture on the same day: which one is "latest" must not change
    wallet("2026-09-01", { wallet_id: "w2", wallet_name: "Other" }),
    wallet("2026-08-15", { fx_usdjpy: 148.5 }), // a day with a wallet row only: its own rate is the one used
  ],
  exchange_snapshots: [
    ...dates.map((d, i) => exchange(d, { totals: { net_asset_usd: 36700 + i } })),
    exchange("2026-09-21", { captured_at: "2026-09-21T08:00:00Z" }),
    exchange("2026-09-10", { fx_usdjpy: 152.25 }), // a day with an exchange row only: currencyHistory takes ITS rate
  ],
});
const rewards = [{ date: "2026-07-13", type: "reward", change: 0.001, change_USD: 3, balance: 119.99, apr: 2.5 }, { date: "2026-07-14", type: "reward", change: 0.002, change_USD: 6, balance: 120, apr: 2.4 }];
const rates = dates.map((date, i) => ({ date, rate: 149 + i }));

const symbols = (history) => [...new Set([...history.snapshots.flatMap((r) => walletPositions([r]).map((p) => p.symbol)), ...history.exchange_snapshots.flatMap((r) => exchangePositions([r]).map((p) => p.symbol))])];

test("the fixture actually walks the fallbacks (so equality below is not vacuous)", () => {
  const found = symbols(richHistory());
  for (const symbol of ["stETH", "ETH", "DUST", "NOPRICE", "資産不明", "PREF", "aWETH", "BAL", "PLAIN", "USDC", "crvUSD", "BTC", "USDT", "JPY", "BNB"]) expect(found, symbol).toContain(symbol);
});

test("currencyHistory is identical for every symbol, with and without FX rates", () => {
  const full = richHistory();
  const cut = currencyFields(full);
  for (const symbol of symbols(full)) {
    for (const fx of [[], rates]) {
      expect(currencyHistory(cut.snapshots, cut.exchange_snapshots, symbol, fx), `${symbol} fx=${fx.length}`).toEqual(currencyHistory(full.snapshots, full.exchange_snapshots, symbol, fx));
    }
  }
});

test("the stETH history (Lido CSV + snapshots) is identical", () => {
  const full = richHistory();
  const cut = currencyFields(full);
  for (const start of [undefined, CUTOVER, "2026-08-01"]) {
    expect(stethRewardHistory(rewards, cut.snapshots, cut.exchange_snapshots, rates, start)).toEqual(stethRewardHistory(rewards, full.snapshots, full.exchange_snapshots, rates, start));
  }
});

test("the overview's trend and previous-day figure are identical when it reads the cut-down rows (after the currency tab was opened)", () => {
  const full = richHistory();
  const cut = currencyFields(full);
  expect(historyPoints(cut.snapshots, cut.exchange_snapshots)).toEqual(historyPoints(full.snapshots, full.exchange_snapshots));
  expect(previousOpeningPoint(cut.snapshots, cut.exchange_snapshots, "2026-09-21")).toEqual(previousOpeningPoint(full.snapshots, full.exchange_snapshots, "2026-09-21"));
});

test("the positions read from a wallet row keep their symbol, quantity, value and location", () => {
  const row = wallet("2026-09-21");
  const key = (p) => ({ symbol: p.symbol, quantity: p.quantity, valueUsd: p.valueUsd, location: p.location, locationType: p.locationType, protocol: p.protocol, positionType: p.positionType });
  expect(walletPositions([currencyWalletRow(row)]).map(key)).toEqual(walletPositions([row]).map(key));
  const ex = exchange("2026-09-21");
  expect(exchangePositions([currencyExchangeRow(ex)]).map(key)).toEqual(exchangePositions([ex]).map(key));
});

test("a row with the fields absent or malformed does not throw and reads the same", () => {
  const odd = { snapshots: [{ wallet_id: "w", as_of_date: "2026-09-21", captured_at: "2026-09-21T00:00:00Z", tokens: "not a list", protocols: null }, { wallet_id: "w0", as_of_date: "2026-09-20", captured_at: "x" }], exchange_snapshots: [{ source_id: "x", as_of_date: "2026-09-21", captured_at: "2026-09-21T00:00:00Z", positions: undefined }] };
  const cut = currencyFields(odd);
  expect(currencyHistory(cut.snapshots, cut.exchange_snapshots, "ETH", [])).toEqual(currencyHistory(odd.snapshots, odd.exchange_snapshots, "ETH", []));
  expect(historyPoints(cut.snapshots, cut.exchange_snapshots)).toEqual(historyPoints(odd.snapshots, odd.exchange_snapshots));
});

test("what is cut: addresses, chain lists, raw hashes, display strings, connector and quality blocks", () => {
  const cut = currencyFields(richHistory());
  const text = JSON.stringify(cut);
  for (const gone of ["0xabc", "chains", "input_sha256", "debank", "change_display", "price_display", "asset_ref", "connector", "quality", "net_asset_jpy", "snapshot_id", "provider", "never read"]) expect(text, gone).not.toContain(gone);
  // Smaller by a good margin on this synthetic data; the real saving (about 46% on a production 90-day window) is measured on real rows.
  expect(JSON.stringify(richHistory()).length / text.length).toBeGreaterThan(1.3);
});

test("a panel that has structured assets keeps no display text; one without them keeps it", () => {
  const row = currencyWalletRow(wallet("2026-09-21"));
  const panels = row.protocols[0].panels;
  expect(panels[0].display_text).toBeUndefined();
  expect(panels[1].display_text).toContain("stETH 1.5");
  expect(panels[2].display_text).toContain("USDC");
});
