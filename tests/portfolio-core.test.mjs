import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, test } from "vitest";

// Replaces tests/rendered-html.test.mjs's "keeps normalized exchange
// quantities in the original Manage Asset client" (Issue #94). That test
// only grepped this file's source for two `??`-fallback-chain expressions
// -- it never actually called the function they live in.
//
// public/manage-asset-original/portfolio-core.js is a UMD module with no
// DOM dependency at all (confirmed by reading it: every function is pure
// data transformation, unlike its sibling compat-fixes.js, which uses
// `document`/MutationObserver and genuinely needs a DOM). It just cannot be
// `require()`'d normally here: this project's package.json has
// `"type": "module"`, so Node's loader treats a plain .js file as ESM, the
// UMD wrapper's `typeof module === 'object'` check sees no injected CJS
// `module` global and evaluates false, and it falls through to its browser
// branch -- `root.PortfolioCore = api`, i.e. a property on globalThis (see
// `typeof globalThis!=='undefined'?globalThis:this` in the wrapper). This
// requires it for that side effect and reads the global it leaves behind,
// deleting it afterward so it cannot leak into any other test file.

let PortfolioCore;

beforeAll(() => {
  const require = createRequire(import.meta.url);
  require("../public/manage-asset-original/portfolio-core.js");
  PortfolioCore = globalThis.PortfolioCore;
});

afterAll(() => {
  delete globalThis.PortfolioCore;
});

test("exchangePositions reads quantity from net_quantity, then quantity, then amount", () => {
  const snapshots = [
    { source_id: "e1", account_name: "Exchange", captured_at: "2026-01-01T00:00:00Z", positions: [
      { symbol: "BTC", net_quantity: 1, quantity: 99, amount: 99, usd_value: 30000 },
      { symbol: "ETH", quantity: 2, amount: 99, usd_value: 5000 },
      { symbol: "USDT", amount: 100, usd_value: 100 },
    ] },
  ];
  const positions = PortfolioCore.exchangePositions(snapshots);
  expect(positions.map((position) => [position.symbol, position.quantity])).toEqual([
    ["BTC", 1],
    ["ETH", 2],
    ["USDT", 100],
  ]);
});

test("exchangePositions reads value from usd_value, then value_usd, then usdValue", () => {
  const snapshots = [
    { source_id: "e1", account_name: "Exchange", captured_at: "2026-01-01T00:00:00Z", positions: [
      { symbol: "BTC", amount: 1, usd_value: 30000, value_usd: 99999, usdValue: 99999 },
      { symbol: "ETH", amount: 2, value_usd: 5000, usdValue: 99999 },
      { symbol: "USDT", amount: 100, usdValue: 100 },
    ] },
  ];
  const positions = PortfolioCore.exchangePositions(snapshots);
  expect(positions.map((position) => [position.symbol, position.value])).toEqual([
    ["BTC", 30000],
    ["ETH", 5000],
    ["USDT", 100],
  ]);
});

test("exchangePositions negates the value of a liability", () => {
  const snapshots = [
    { source_id: "e1", account_name: "Exchange", captured_at: "2026-01-01T00:00:00Z", positions: [
      { symbol: "USDT", amount: 1000, usd_value: 1000, is_liability: true },
    ] },
  ];
  expect(PortfolioCore.exchangePositions(snapshots)[0].value).toBe(-1000);
});
