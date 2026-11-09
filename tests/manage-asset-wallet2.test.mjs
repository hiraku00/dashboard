import { expect, test } from "vitest";

import { exchangePositions, normalizeSyncedPositions, reconciliation, total, walletPositions } from "../app/lib/manage-asset-core.ts";
import {
  demoFactor,
  formatLike,
  scaleAssetRecord,
  scaleLidoReward,
  scaleNumberLike,
  scalePanelText,
  scalePositionRow,
  scaleSnapshotTotals,
  scaleSyncEntry,
  wallet2Address,
} from "../app/lib/manage-asset-wallet2.ts";

// ウォレット2（ダミーデータ）は、本番の数量と評価額を通貨ごとの倍率で増やしたもの。
// 倍率の規則と、増やしたあとも本番と同じ形式・同じ読まれ方になることを確かめる。

const close = (actual, expected, tolerance = 1e-6) =>
  expect(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`).toBeTruthy();

test("demoFactor: stETH 8, BTC 15, USDT 1000, everything else (wstETH and WBTC too) 100", () => {
  expect(demoFactor("stETH")).toBe(8);
  expect(demoFactor("STETH")).toBe(8);
  expect(demoFactor("BTC")).toBe(15);
  expect(demoFactor("USDT")).toBe(1000);
  expect(demoFactor("wstETH")).toBe(100);
  expect(demoFactor("WBTC")).toBe(100);
  expect(demoFactor("ETH")).toBe(100);
  expect(demoFactor("JPY")).toBe(100);
  expect(demoFactor(undefined)).toBe(100);
});

test("scaleNumberLike keeps how the value was written", () => {
  expect(scaleNumberLike(2.5, 100)).toBe(250);
  expect(scaleNumberLike("0.0083", 100)).toBe("0.8300");
  expect(scaleNumberLike("30", 100)).toBe("3000");
  expect(scaleNumberLike("$5.74", 100)).toBe("$574.00");
  expect(scaleNumberLike("$22.41", 100)).toBe("$2,241.00");
  expect(scaleNumberLike("1,234.5", 8)).toBe("9,876.0");
  expect(scaleNumberLike("0E-30", 100)).toBe("0");
  expect(scaleNumberLike("-$3.5", 100)).toBe("-$350.0");
  // Unreadable values stay as they are -- production cannot read them either.
  expect(scaleNumberLike("<0.0001", 100)).toBe("<0.0001");
  expect(scaleNumberLike("", 100)).toBe("");
  expect(scaleNumberLike(null, 100)).toBe(null);
  expect(scaleNumberLike(false, 100)).toBe(false);
});

test("formatLike writes very long exchange decimals plainly instead of inventing digits", () => {
  const next = formatLike("0.06943348587659775919204670980", 6.943348587659776);
  expect(Number(next)).toBeCloseTo(6.943348587659776, 12);
});

test("scalePanelText rewrites only the quantity and the USD value of an old DeFi panel", () => {
  const { text, delta } = scalePanelText("Deposit Pool Balance USD Value ETH 0.0100 ETH $22.41");
  expect(text).toBe("Deposit Pool Balance USD Value ETH 1.0000 ETH $2,241.00");
  close(delta, 22.41 * 99);
  const steth = scalePanelText("Pool USD Value stETH 1,234.5 stETH ... $ 3,086,250");
  expect(steth.text).toBe("Pool USD Value stETH 9,876.0 stETH ... $ 24,690,000");
  expect(scalePanelText("nothing parseable here")).toEqual({ text: "nothing parseable here", delta: 0 });
});

const wallet = {
  wallet_id: "w1",
  wallet_name: "Main",
  address: "0xAbCdEf0123456789abcdef0123456789ABCDEF01",
  as_of_date: "2026-11-08",
  captured_at: "2026-11-08T00:00:00Z",
  fx_usdjpy: 150,
  total_usd: "4030",
  chains: [{ chain_id: "eth", name: "Ethereum", usd_value: "4030" }],
  tokens: [
    { symbol: "ETH", amount_display: "0.0100", usd_value_display: "$20.00", price_display: "$2,000.0000" },
    { symbol: "USDT", amount_display: "10", usd_value_display: "$10.00" },
  ],
  protocols: [
    { name: "Lido", usd_value: "4000", panels: [{ display_text: "", assets: [{ asset_symbol: "stETH", amount_value: 1, amount_display: "1.0000", usd_value: 4000, usd_value_display: "$4,000" }] }] },
  ],
};

test("scaleAssetRecord scales every holding of a wallet by its own factor and rebuilds the total", () => {
  const { record, deltaUsd } = scaleAssetRecord(wallet);
  const before = walletPositions([wallet]);
  const after = walletPositions([record]);
  expect(after.map((p) => p.symbol)).toEqual(before.map((p) => p.symbol));
  for (const [index, position] of after.entries()) {
    const factor = demoFactor(position.symbol);
    close(position.quantity, before[index].quantity * factor);
    close(position.valueUsd, before[index].valueUsd * factor);
  }
  close(deltaUsd, 20 * 99 + 10 * 999 + 4000 * 7);
  expect(record.total_usd).toBe(String(4030 + deltaUsd));
  expect(record.protocols[0].usd_value).toBe("32000");
  // Prices, dates, names and the rate are not amounts and stay the same.
  expect(record.tokens[0].price_display).toBe("$2,000.0000");
  expect(record.fx_usdjpy).toBe(150);
  expect(record.wallet_name).toBe("Main");
  expect(record.as_of_date).toBe("2026-11-08");
  // The real address never reaches wallet 2.
  expect(record.address).not.toBe(wallet.address);
  expect(record.address).toMatch(/^0x[0-9a-f]{40}$/);
  // The input is not modified.
  expect(wallet.tokens[0].amount_display).toBe("0.0100");
});

test("scaleAssetRecord leaves the gap between the stated total and the detail exactly as it was", () => {
  // DeBank rounds a small wallet's header total to an integer, so the stated total and the
  // sum of the detail differ in production; wallet 2 must keep the same gap, not invent or hide one.
  const rounded = { ...wallet, total_usd: "4031" };
  const { record } = scaleAssetRecord(rounded);
  const gapBefore = reconciliation([rounded], []);
  const gapAfter = reconciliation([record], []);
  close(gapAfter.difference ?? gapAfter.diff ?? 0, gapBefore.difference ?? gapBefore.diff ?? 0);
});

const exchange = {
  source_id: "src_x",
  account_name: "bitFlyer",
  provider: "bitflyer",
  as_of_date: "2026-11-08",
  captured_at: "2026-11-08T00:00:00Z",
  fx_usdjpy: "150",
  totals: { gross_asset_usd: "1100", liability_usd: "100", net_asset_usd: "1000", unpriced_count: 0 },
  positions: [
    { symbol: "BTC", quantity: "0.01", net_quantity: "0.01", available_quantity: "0.01", locked_quantity: "0", borrowed_quantity: "0", price: "100000", usd_value: "1000", asset_usd_value: "1000", liability_usd_value: "0", is_liability: false },
    { symbol: "JPY", quantity: "15000", net_quantity: "15000", price: "0.00666", usd_value: "100", asset_usd_value: "100", liability_usd_value: "0", is_liability: false },
    { symbol: "USDT", quantity: "100", net_quantity: "100", price: "1", usd_value: "100", asset_usd_value: "0", liability_usd_value: "100", is_liability: true },
  ],
};

test("scaleAssetRecord scales an exchange's positions and keeps its totals consistent, liabilities included", () => {
  const { record, deltaUsd } = scaleAssetRecord(exchange);
  const before = exchangePositions([exchange]);
  const after = exchangePositions([record]);
  for (const [index, position] of after.entries()) {
    const factor = demoFactor(position.symbol);
    close(position.quantity, before[index].quantity * factor);
    close(position.valueUsd, before[index].valueUsd * factor);
  }
  close(deltaUsd, 1000 * 14 + 100 * 99 - 100 * 999);
  close(Number(record.totals.net_asset_usd), 1000 + deltaUsd);
  close(Number(record.totals.gross_asset_usd), 1100 + 1000 * 14 + 100 * 99);
  close(Number(record.totals.liability_usd), 100 + 100 * 999);
  close(Number(record.totals.gross_asset_usd) - Number(record.totals.liability_usd), Number(record.totals.net_asset_usd));
  expect(record.positions[0].price).toBe("100000");
  expect(record.account_name).toBe("bitFlyer");
  expect(total([], [record])).toBeCloseTo(1000 + deltaUsd, 6);
});

test("scaleSyncEntry scales the sync payload the way the sync route stores it, and hides the address", () => {
  const entry = {
    source: { sourceId: "w1", sourceType: "wallet", provider: "debank", displayName: "Main", publicAddress: wallet.address },
    snapshot: { ...wallet, capturedAt: wallet.captured_at, asOfDate: wallet.as_of_date, totalUsd: "4030", totalJpy: 604500, fxUsdjpy: 150 },
    positions: wallet.tokens,
  };
  const scaled = scaleSyncEntry(entry);
  const delta = 20 * 99 + 10 * 999 + 4000 * 7;
  expect(scaled.source.publicAddress).toBe(wallet2Address(wallet.address));
  expect(scaled.source.displayName).toBe("Main");
  expect(scaled.snapshot.totalUsd).toBe(String(4030 + delta));
  close(scaled.snapshot.totalJpy, 604500 + delta * 150);
  expect(scaled.positions[1].amount_display).toBe("10000");
  // What the sync route actually stores comes from normalizeSyncedPositions().
  const stored = normalizeSyncedPositions(scaled.source, scaled.snapshot, scaled.positions);
  const original = normalizeSyncedPositions(entry.source, entry.snapshot, entry.positions);
  for (const [index, position] of stored.entries()) close(position.valueUsd, original[index].valueUsd * demoFactor(position.symbol));
});

test("scalePositionRow and scaleSnapshotTotals rebuild a stored D1 snapshot the same way", () => {
  const rows = [
    { symbol: "stETH", quantity: 1, price_usd: 4000, value_usd: 4000, value_jpy: 600000 },
    { symbol: "USDT", quantity: 100, price_usd: 1, value_usd: -100, value_jpy: -15000 },
  ];
  let delta = 0;
  const scaled = rows.map((row) => {
    const result = scalePositionRow(row);
    delta += result.deltaUsd;
    return result.row;
  });
  expect(scaled[0]).toMatchObject({ quantity: 8, price_usd: 4000, value_usd: 32000, value_jpy: 4800000 });
  expect(scaled[1]).toMatchObject({ quantity: 100000, value_usd: -100000 });
  const snapshot = scaleSnapshotTotals({ total_usd: 3900, total_jpy: 585000, fx_usdjpy: 150 }, delta);
  close(snapshot.total_usd, 32000 - 100000);
  close(snapshot.total_jpy, (32000 - 100000) * 150);
  // Without a rate, JPY grows in proportion to USD.
  close(scaleSnapshotTotals({ total_usd: 100, total_jpy: 15000, fx_usdjpy: null }, 900).total_jpy, 150000);
});

test("scaleLidoReward multiplies the stETH amounts by 8 and leaves the APR and date alone", () => {
  expect(scaleLidoReward({ date: "2026-01-01", type: "reward", change: 0.001, change_USD: 4, apr: 2.8, balance: 1.5 }))
    .toEqual({ date: "2026-01-01", type: "reward", change: 0.008, change_USD: 32, apr: 2.8, balance: 12 });
});

test("wallet2Address is a stable look-alike that never equals the real address", () => {
  const real = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";
  expect(wallet2Address(real)).toBe(wallet2Address(real));
  expect(wallet2Address(real)).toBe(wallet2Address(real.toLowerCase()));
  expect(wallet2Address(real)).not.toBe(real.toLowerCase());
  expect(wallet2Address(real)).toHaveLength(real.length);
  expect(wallet2Address("0x1111111111111111111111111111111111111111")).not.toBe(wallet2Address("0x2222222222222222222222222222222222222222"));
  expect(wallet2Address("")).toBe("");
});
