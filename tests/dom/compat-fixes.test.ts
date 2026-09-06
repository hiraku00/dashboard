import { beforeEach, expect, test } from "vitest";

// Replaces tests/rendered-html.test.mjs's "labels non-stETH balance deltas
// as changes rather than rewards" (Issue #94). That test only grepped
// public/manage-asset-original/compat-fixes.js for two string literals
// (`select.value.toLowerCase() === 'steth'` and `nodeValue === 'Reward'`) --
// it never actually loaded the script or observed it relabel anything.
//
// compat-fixes.js is a bare IIFE, not a module -- it reads
// document.getElementById('currencyTable')/('currencySelect') and returns
// immediately if either is missing, so the DOM has to exist *before* the
// script runs. It also runs once per unique import specifier (ESM module
// caching), so each test below busts the cache with a distinct query string
// to force a fresh run against that test's own DOM setup, rather than
// sharing one run across all three.
//
// This needs a real DOM (`environment: "jsdom"`, see vitest.config.ts's
// "dom" project) -- unlike its sibling portfolio-core.js
// (tests/portfolio-core.test.mjs), which turned out to have no DOM
// dependency at all.

// The `as unknown as HTMLSelectElement` double-cast below (also in the third
// test) isn't stylistic -- `document.querySelector<HTMLSelectElement>(...)`
// fails tsc with "HTMLSelectElement does not satisfy the constraint
// 'Element'" once jsdom/@testing-library/react are installed (this file's
// PR). Something in that dependency graph merges a conflicting global
// declaration of `Element` (not tracked down to a specific package), which
// only surfaces because this project's tsconfig has no explicit `types`
// restriction, so tsc auto-includes every package's ambient globals.
// Casting through `unknown` skips the generic constraint check that trips
// over it, without touching the shared tsconfig.

function setUpTable(selectedCurrency: string) {
  document.body.innerHTML = `
    <select id="currencySelect">
      <option value="btc">BTC</option>
      <option value="steth">stETH</option>
    </select>
    <table id="currencyTable">
      <thead><tr><th>Date</th><th>Reward</th><th>Balance</th></tr></thead>
    </table>
  `;
  (document.getElementById("currencySelect") as unknown as HTMLSelectElement).value = selectedCurrency;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

test("relabels the 'Reward' column header to 'Change' for a non-stETH currency", async () => {
  setUpTable("btc");
  // @ts-expect-error -- the cache-busting query string (see the file
  // comment above) isn't a real module tsc can resolve.
  await import(`../../public/manage-asset-original/compat-fixes.js?relabel-btc`);
  const headers = [...document.querySelectorAll("#currencyTable th")].map((header) => header.textContent);
  expect(headers).toEqual(["Date", "Change", "Balance"]);
});

test("leaves the 'Reward' column header alone for stETH", async () => {
  setUpTable("steth");
  // @ts-expect-error -- see the previous test's comment
  await import(`../../public/manage-asset-original/compat-fixes.js?relabel-steth`);
  const headers = [...document.querySelectorAll("#currencyTable th")].map((header) => header.textContent);
  expect(headers).toEqual(["Date", "Reward", "Balance"]);
});

test("relabels again when the selected currency changes after load", async () => {
  setUpTable("steth");
  // @ts-expect-error -- see the first test's comment
  await import(`../../public/manage-asset-original/compat-fixes.js?relabel-reactive`);
  const select = document.getElementById("currencySelect") as unknown as HTMLSelectElement;
  select.value = "btc";
  select.dispatchEvent(new Event("change"));
  const headers = [...document.querySelectorAll("#currencyTable th")].map((header) => header.textContent);
  expect(headers).toEqual(["Date", "Change", "Balance"]);
});
