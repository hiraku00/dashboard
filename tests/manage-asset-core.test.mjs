import { expect, test } from "vitest";

import {
  currencyHistory,
  exchangePositions,
  historyPoints,
  holdingsFromPositions,
  legacyDeFiAsset,
  normalizeSyncedPositions,
  stethRewardHistory,
  walletPositions,
} from "../app/lib/manage-asset-core.ts";

// This module turns collector snapshots into the numbers the Manage Asset
// screens show -- balances, valuations, daily deltas, APR. It had no tests at
// all, while several of the bugs fixed in this area (stETH hidden inside
// protocols[].panels[].assets[], retried syncs double-counting, liabilities
// flipping a total's sign) were exactly the kind a unit test pins down.

const close = (actual, expected, tolerance = 1e-9) =>
  expect(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`).toBeTruthy();

test("walletPositions reads plain wallet tokens", () => {
  const positions = walletPositions([
    {
      wallet_id: "w1",
      wallet_name: "Main",
      captured_at: "2026-09-05T10:00:00Z",
      tokens: [{ symbol: "ETH", amount_value: 2, usd_value_display: 5000 }],
    },
  ]);
  expect(positions.length).toBe(1);
  expect(positions[0]).toEqual({
    symbol: "ETH",
    quantity: 2,
    valueUsd: 5000,
    location: "Main",
    locationType: "wallet",
    protocol: "",
    positionType: "asset",
    unpriced: false,
  });
});

test("walletPositions reaches assets nested under protocols[].panels[]", () => {
  // The regression this pins: a wallet's stETH lives in the DeBank snapshot
  // under protocols[].panels[].assets[], not in tokens[]. Reading only the
  // flattened token list silently dropped the whole staked balance.
  const positions = walletPositions([
    {
      wallet_id: "w1",
      wallet_name: "Main",
      captured_at: "2026-09-05T10:00:00Z",
      tokens: [{ symbol: "ETH", amount_value: 1, usd_value_display: 2500 }],
      protocols: [
        {
          name: "Lido",
          panels: [{ assets: [{ asset_symbol: "stETH", amount_value: 8, usd_value: 20000 }] }],
        },
      ],
    },
  ]);
  expect(positions.map((position) => [position.symbol, position.quantity, position.valueUsd, position.protocol])).toEqual([
    ["ETH", 1, 2500, ""],
    ["stETH", 8, 20000, "Lido"],
  ]);
  expect(positions[1].locationType).toBe("defi");
});

test("walletPositions keeps only the newest snapshot per wallet", () => {
  // A retried sync can leave two snapshots for the same wallet. Summing both
  // would double the portfolio.
  const positions = walletPositions([
    {
      wallet_id: "w1",
      wallet_name: "Main",
      captured_at: "2026-09-05T09:00:00Z",
      tokens: [{ symbol: "ETH", amount_value: 1, usd_value_display: 2500 }],
    },
    {
      wallet_id: "w1",
      wallet_name: "Main",
      captured_at: "2026-09-05T10:00:00Z",
      tokens: [{ symbol: "ETH", amount_value: 3, usd_value_display: 7500 }],
    },
  ]);
  expect(positions.length).toBe(1);
  expect(positions[0].quantity).toBe(3);
});

test("walletPositions marks a token with no USD value as unpriced", () => {
  const [position] = walletPositions([
    {
      wallet_id: "w1",
      captured_at: "2026-09-05T10:00:00Z",
      tokens: [{ symbol: "SCAM", amount_value: 1000 }],
    },
  ]);
  expect(position.unpriced).toBe(true);
  expect(position.valueUsd).toBe(0);
});

test("exchangePositions negates liabilities and tags them as debt", () => {
  // A borrow reported as a positive usd_value would otherwise inflate the
  // total instead of reducing it.
  const positions = exchangePositions([
    {
      source_id: "e1",
      account_name: "Binance",
      captured_at: "2026-09-05T10:00:00Z",
      positions: [
        { symbol: "BTC", net_quantity: 0.5, usd_value: 30000 },
        { symbol: "USDT", quantity: 1000, usd_value: 1000, is_liability: true },
      ],
    },
  ]);
  expect(positions.map((position) => [position.symbol, position.valueUsd, position.positionType])).toEqual([
    ["BTC", 30000, "asset"],
    ["USDT", -1000, "debt"],
  ]);
});

test("normalizeSyncedPositions routes by source type", () => {
  const wallet = normalizeSyncedPositions(
    { sourceType: "wallet", sourceId: "w1", displayName: "Main" },
    { capturedAt: "2026-09-05T10:00:00Z", tokens: [{ symbol: "ETH", amount_value: 2, usd_value_display: 5000 }] },
    [],
  );
  expect(wallet.map((p) => [p.symbol, p.locationType])).toEqual([["ETH", "wallet"]]);

  const exchange = normalizeSyncedPositions(
    { sourceType: "exchange", sourceId: "e1", displayName: "Binance" },
    { capturedAt: "2026-09-05T10:00:00Z" },
    [{ symbol: "BTC", quantity: 1, usd_value: 60000 }],
  );
  expect(exchange.map((p) => [p.symbol, p.locationType, p.valueUsd])).toEqual([["BTC", "exchange", 60000]]);
});

test("holdingsFromPositions sums a symbol across locations and derives a unit price", () => {
  const holdings = holdingsFromPositions([
    { symbol: "ETH", quantity: 2, valueUsd: 5000, location: "Main", locationType: "wallet", protocol: "", positionType: "asset", unpriced: false },
    { symbol: "ETH", quantity: 1, valueUsd: 2500, location: "Binance", locationType: "exchange", protocol: "", positionType: "asset", unpriced: false },
    { symbol: "BTC", quantity: 0.1, valueUsd: 6000, location: "Binance", locationType: "exchange", protocol: "", positionType: "asset", unpriced: false },
  ]);
  // Sorted by value, so BTC (6000) comes before ETH (7500)? No -- ETH totals
  // 7500 across two locations, so it leads.
  expect(holdings.map((h) => h.symbol)).toEqual(["ETH", "BTC"]);
  const eth = holdings[0];
  expect(eth.quantity).toBe(3);
  expect(eth.valueUsd).toBe(7500);
  expect(eth.unitPriceUsd).toBe(2500);
  // Locations are ordered by how much value each holds.
  expect(eth.locations).toEqual(["Main", "Binance"]);
});

test("holdingsFromPositions leaves the unit price null when the quantity is unknown", () => {
  const [holding] = holdingsFromPositions([
    { symbol: "ETH", quantity: null, valueUsd: 5000, location: "Main", locationType: "wallet", protocol: "", positionType: "asset", unpriced: false },
  ]);
  expect(holding.quantityKnown).toBe(false);
  expect(holding.unitPriceUsd).toBe(null);
});

test("historyPoints totals each date and keeps the newest record per source", () => {
  const points = historyPoints(
    [
      { wallet_id: "w1", as_of_date: "2026-09-04", captured_at: "2026-09-04T10:00:00Z", total_usd: 100 },
      // Same wallet and date, retried later: must replace, not add.
      { wallet_id: "w1", as_of_date: "2026-09-04", captured_at: "2026-09-04T11:00:00Z", total_usd: 110 },
      { wallet_id: "w1", as_of_date: "2026-09-05", captured_at: "2026-09-05T10:00:00Z", total_usd: 120 },
    ],
    [
      { source_id: "e1", as_of_date: "2026-09-04", captured_at: "2026-09-04T10:00:00Z", totals: { net_asset_usd: 50 } },
      { source_id: "e1", as_of_date: "2026-09-05", captured_at: "2026-09-05T10:00:00Z", totals: { net_asset_usd: 60 } },
    ],
  );
  expect(points).toEqual([
    { date: "2026-09-04", value: 160 },
    { date: "2026-09-05", value: 180 },
  ]);
});

test("currencyHistory reports the daily delta, price and APR for one symbol", () => {
  const wallets = [
    {
      wallet_id: "w1",
      as_of_date: "2026-09-04",
      captured_at: "2026-09-04T10:00:00Z",
      fx_usdjpy: 150,
      tokens: [{ symbol: "ETH", amount_value: 10, usd_value_display: 25000 }],
    },
    {
      wallet_id: "w1",
      as_of_date: "2026-09-05",
      captured_at: "2026-09-05T10:00:00Z",
      fx_usdjpy: 150,
      tokens: [{ symbol: "ETH", amount_value: 11, usd_value_display: 27500 }],
    },
  ];
  const rows = currencyHistory(wallets, [], "ETH", []);
  expect(rows.length).toBe(2);
  expect(rows[0].delta, "the first day has nothing to compare against").toBe(null);
  expect(rows[1].quantity).toBe(11);
  expect(rows[1].delta).toBe(1);
  expect(rows[1].price).toBe(2500);
  expect(rows[1].usd).toBe(2500);
  expect(rows[1].yen).toBe(375000);
  close(rows[1].apr, (1 / 10) * 365 * 100);
});

test("currencyHistory matches the symbol case-insensitively and skips zero days", () => {
  const rows = currencyHistory(
    [
      {
        wallet_id: "w1",
        as_of_date: "2026-09-04",
        captured_at: "2026-09-04T10:00:00Z",
        tokens: [{ symbol: "stETH", amount_value: 0, usd_value_display: 0 }],
      },
      {
        wallet_id: "w1",
        as_of_date: "2026-09-05",
        captured_at: "2026-09-05T10:00:00Z",
        tokens: [{ symbol: "stETH", amount_value: 4, usd_value_display: 10000 }],
      },
    ],
    [],
    "STETH",
    [],
  );
  expect(rows.map((row) => row.date)).toEqual(["2026-09-05"]);
});

test("stethRewardHistory continues the CSV series with snapshot-derived rows", () => {
  // The cutover case: Lido's CSV covers the past, snapshots take over after
  // its last date. Rows before the cutover must stay untouched, and the first
  // snapshot row's change is measured against the CSV's final balance.
  const rewards = [
    { date: "2026-09-03", type: "reward", change: 0.01, change_USD: 25, apr: 3.2, balance: 10 },
    { date: "2026-09-04", type: "reward", change: 0.01, change_USD: 25, apr: 3.2, balance: 10.01 },
    { date: "2026-09-04", type: "deposit", change: 5, change_USD: 12500, balance: 15.01 },
  ];
  const wallets = [
    {
      wallet_id: "w1",
      as_of_date: "2026-09-05",
      captured_at: "2026-09-05T10:00:00Z",
      fx_usdjpy: 150,
      tokens: [{ symbol: "stETH", amount_value: 10.03, usd_value_display: 25075 }],
    },
  ];
  const rows = stethRewardHistory(rewards, wallets, [], []);
  // The non-reward row is dropped; two CSV rows plus one snapshot row remain.
  expect(rows.map((row) => [row.date, row.source])).toEqual([
    ["2026-09-03", "csv"],
    ["2026-09-04", "csv"],
    ["2026-09-05", "snapshot"],
  ]);
  close(rows[2].change, 10.03 - 10.01, 1e-9);
  expect(rows[2].balance).toBe(10.03);
});

test("stethRewardHistory drops snapshot dates the CSV already covers", () => {
  const rewards = [{ date: "2026-09-05", type: "reward", change: 0.01, change_USD: 25, balance: 10 }];
  const wallets = [
    {
      wallet_id: "w1",
      as_of_date: "2026-09-05",
      captured_at: "2026-09-05T10:00:00Z",
      tokens: [{ symbol: "stETH", amount_value: 99, usd_value_display: 250000 }],
    },
  ];
  const rows = stethRewardHistory(rewards, wallets, [], []);
  expect(rows.map((row) => [row.date, row.source])).toEqual([["2026-09-05", "csv"]]);
});

test("legacyDeFiAsset parses the two display_text shapes it has seen", () => {
  expect(legacyDeFiAsset({ display_text: "Pool USD Value stETH 1,234.5 stETH ... $ 3,086,250" })).toEqual({ symbol: "stETH", quantity: 1234.5, valueUsd: 3086250, unpriced: false });
  // The alternate ordering: symbol, token name, then the amount.
  expect(legacyDeFiAsset({ display_text: "USD Value ETH ETH 2.5 blah $ 6,250" })).toEqual({ symbol: "ETH", quantity: 2.5, valueUsd: 6250, unpriced: false });
  expect(legacyDeFiAsset({ display_text: "nothing parseable here" })).toBe(null);
  expect(legacyDeFiAsset({})).toBe(null);
});
