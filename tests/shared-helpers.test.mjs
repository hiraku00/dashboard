import assert from "node:assert/strict";
import test from "node:test";

import { canonicalUrl, clean, validDate } from "../app/lib/text.ts";
import { youTubeVideoId } from "../app/lib/youtube.ts";
import {
  toLegacyExchangeSnapshot,
  toLegacyWalletSnapshot,
} from "../app/lib/manage-asset-legacy.ts";

// These helpers were each duplicated across two or three call sites, and the
// copies had drifted. The point of these tests is to pin the single behaviour
// they now share, so a future edit cannot quietly reintroduce a difference.

test("canonicalUrl strips the fragment and tracking params", () => {
  assert.equal(
    canonicalUrl("https://example.com/a?utm_source=x&keep=1&fbclid=y#frag"),
    "https://example.com/a?keep=1",
  );
  // The seed loop and /api/imports used to strip only the fragment, so the
  // same link got a different canonical_url depending on how it arrived.
  assert.equal(
    canonicalUrl("https://example.com/a?utm_medium=email"),
    "https://example.com/a",
  );
  assert.equal(canonicalUrl("not a url"), "");
});

test("canonicalUrl rejects schemes other than http/https", () => {
  // new URL() does not throw on these -- it happily parses "javascript:"
  // and "data:" URIs -- so without an explicit protocol check they used to
  // pass straight through despite every caller's error message claiming
  // only http/https URLs are accepted. See Issue #74.
  assert.equal(canonicalUrl("javascript:alert(1)"), "");
  assert.equal(canonicalUrl("data:text/html,<script>alert(1)</script>"), "");
  assert.equal(canonicalUrl("ftp://example.com/file"), "");
});

test("clean trims, truncates and rejects non-strings", () => {
  assert.equal(clean("  hi  "), "hi");
  assert.equal(clean("abcdef", 3), "abc");
  assert.equal(clean(42), "");
  assert.equal(clean(null), "");
});

test("validDate accepts empty and YYYY-MM-DD only", () => {
  assert.equal(validDate(""), true);
  assert.equal(validDate("2026-09-04"), true);
  assert.equal(validDate("2026/09/04"), false);
  assert.equal(validDate("2026-9-4"), false);
});

test("youTubeVideoId reads every YouTube URL form", () => {
  const id = "dQw4w9WgXcQ";
  assert.equal(youTubeVideoId(`https://www.youtube.com/watch?v=${id}`), id);
  assert.equal(youTubeVideoId(`https://m.youtube.com/watch?v=${id}`), id);
  assert.equal(youTubeVideoId(`https://music.youtube.com/watch?v=${id}`), id);
  assert.equal(youTubeVideoId(`https://www.youtube.com/shorts/${id}`), id);
  assert.equal(youTubeVideoId(`https://www.youtube.com/embed/${id}`), id);
  assert.equal(youTubeVideoId(`https://www.youtube.com/live/${id}`), id);
  assert.equal(youTubeVideoId(`https://youtu.be/${id}`), id);
  // The looser text-tube copy missed both of these: www.youtu.be, and a
  // trailing slash (it read the id with pathname.slice(1)).
  assert.equal(youTubeVideoId(`https://www.youtu.be/${id}`), id);
  assert.equal(youTubeVideoId(`https://youtu.be/${id}/`), id);
});

test("youTubeVideoId rejects non-YouTube and non-http URLs", () => {
  const id = "dQw4w9WgXcQ";
  // The text-tube copy had no protocol check, so these reached the fetch.
  assert.equal(youTubeVideoId(`javascript:alert(1)//${id}`), "");
  assert.equal(youTubeVideoId(`file:///tmp/${id}`), "");
  assert.equal(youTubeVideoId("https://example.com/watch?v=" + id), "");
  assert.equal(youTubeVideoId("https://www.youtube.com/watch?v=short"), "");
  assert.equal(youTubeVideoId(""), "");
  assert.equal(youTubeVideoId(undefined), "");
  assert.equal(youTubeVideoId(12345), "");
});

const snapshotRow = {
  source_id: "w1",
  display_name: "Main Wallet",
  public_address: "0xabc",
  as_of_date: "2026-09-04",
  captured_at: "2026-09-04T10:00:00Z",
  sync_received_at: "2026-09-04T10:00:05Z",
  fx_usdjpy: 150,
  total_usd: 100,
  total_jpy: 15000,
};
const positionRow = {
  symbol: "ETH",
  quantity: 2,
  value_usd: 100,
  protocol: "spot",
  is_debt: 0,
};

test("toLegacyWalletSnapshot emits both usd_value names", () => {
  const result = toLegacyWalletSnapshot(snapshotRow, [positionRow]);
  assert.equal(result.wallet_id, "w1");
  assert.equal(result.wallet_name, "Main Wallet");
  assert.equal(result.address, "0xabc");
  assert.equal(result.total_usd, 100);
  assert.equal(result.sync_received_at, "2026-09-04T10:00:05Z");
  // state's copy emitted only usd_value_display, history's emitted both.
  assert.deepEqual(result.tokens, [
    { symbol: "ETH", amount_value: 2, usd_value_display: 100, usd_value: 100 },
  ]);
});

test("toLegacyExchangeSnapshot emits net_quantity and nests totals", () => {
  const result = toLegacyExchangeSnapshot(snapshotRow, [positionRow]);
  assert.equal(result.source_id, "w1");
  assert.equal(result.account_name, "Main Wallet");
  assert.deepEqual(result.totals, { net_asset_usd: 100, net_asset_jpy: 15000 });
  // history's copy omitted net_quantity, state's included it.
  assert.deepEqual(result.positions, [
    {
      symbol: "ETH",
      quantity: 2,
      net_quantity: 2,
      usd_value: 100,
      is_liability: false,
      account_type: "spot",
    },
  ]);
});

test("toLegacyExchangeSnapshot marks debt positions as liabilities", () => {
  const result = toLegacyExchangeSnapshot(snapshotRow, [
    { ...positionRow, is_debt: 1 },
  ]);
  assert.equal(result.positions[0].is_liability, true);
});
