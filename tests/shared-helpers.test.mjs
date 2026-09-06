import { expect, test } from "vitest";

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
  expect(canonicalUrl("https://example.com/a?utm_source=x&keep=1&fbclid=y#frag")).toBe("https://example.com/a?keep=1");
  // The seed loop and /api/imports used to strip only the fragment, so the
  // same link got a different canonical_url depending on how it arrived.
  expect(canonicalUrl("https://example.com/a?utm_medium=email")).toBe("https://example.com/a");
  expect(canonicalUrl("not a url")).toBe("");
});

test("canonicalUrl rejects schemes other than http/https", () => {
  // new URL() does not throw on these -- it happily parses "javascript:"
  // and "data:" URIs -- so without an explicit protocol check they used to
  // pass straight through despite every caller's error message claiming
  // only http/https URLs are accepted. See Issue #74.
  expect(canonicalUrl("javascript:alert(1)")).toBe("");
  expect(canonicalUrl("data:text/html,<script>alert(1)</script>")).toBe("");
  expect(canonicalUrl("ftp://example.com/file")).toBe("");
});

test("clean trims, truncates and rejects non-strings", () => {
  expect(clean("  hi  ")).toBe("hi");
  expect(clean("abcdef", 3)).toBe("abc");
  expect(clean(42)).toBe("");
  expect(clean(null)).toBe("");
});

test("validDate accepts empty and YYYY-MM-DD only", () => {
  expect(validDate("")).toBe(true);
  expect(validDate("2026-09-04")).toBe(true);
  expect(validDate("2026/09/04")).toBe(false);
  expect(validDate("2026-9-4")).toBe(false);
});

test("youTubeVideoId reads every YouTube URL form", () => {
  const id = "dQw4w9WgXcQ";
  expect(youTubeVideoId(`https://www.youtube.com/watch?v=${id}`)).toBe(id);
  expect(youTubeVideoId(`https://m.youtube.com/watch?v=${id}`)).toBe(id);
  expect(youTubeVideoId(`https://music.youtube.com/watch?v=${id}`)).toBe(id);
  expect(youTubeVideoId(`https://www.youtube.com/shorts/${id}`)).toBe(id);
  expect(youTubeVideoId(`https://www.youtube.com/embed/${id}`)).toBe(id);
  expect(youTubeVideoId(`https://www.youtube.com/live/${id}`)).toBe(id);
  expect(youTubeVideoId(`https://youtu.be/${id}`)).toBe(id);
  // The looser text-tube copy missed both of these: www.youtu.be, and a
  // trailing slash (it read the id with pathname.slice(1)).
  expect(youTubeVideoId(`https://www.youtu.be/${id}`)).toBe(id);
  expect(youTubeVideoId(`https://youtu.be/${id}/`)).toBe(id);
});

test("youTubeVideoId rejects non-YouTube and non-http URLs", () => {
  const id = "dQw4w9WgXcQ";
  // The text-tube copy had no protocol check, so these reached the fetch.
  expect(youTubeVideoId(`javascript:alert(1)//${id}`)).toBe("");
  expect(youTubeVideoId(`file:///tmp/${id}`)).toBe("");
  expect(youTubeVideoId("https://example.com/watch?v=" + id)).toBe("");
  expect(youTubeVideoId("https://www.youtube.com/watch?v=short")).toBe("");
  expect(youTubeVideoId("")).toBe("");
  expect(youTubeVideoId(undefined)).toBe("");
  expect(youTubeVideoId(12345)).toBe("");
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
  expect(result.wallet_id).toBe("w1");
  expect(result.wallet_name).toBe("Main Wallet");
  expect(result.address).toBe("0xabc");
  expect(result.total_usd).toBe(100);
  expect(result.sync_received_at).toBe("2026-09-04T10:00:05Z");
  // state's copy emitted only usd_value_display, history's emitted both.
  expect(result.tokens).toEqual([
    { symbol: "ETH", amount_value: 2, usd_value_display: 100, usd_value: 100 },
  ]);
});

test("toLegacyExchangeSnapshot emits net_quantity and nests totals", () => {
  const result = toLegacyExchangeSnapshot(snapshotRow, [positionRow]);
  expect(result.source_id).toBe("w1");
  expect(result.account_name).toBe("Main Wallet");
  expect(result.totals).toEqual({ net_asset_usd: 100, net_asset_jpy: 15000 });
  // history's copy omitted net_quantity, state's included it.
  expect(result.positions).toEqual([
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
  expect(result.positions[0].is_liability).toBe(true);
});
