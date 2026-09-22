import { expect, test } from "vitest";

import { MAX_LIKE_TERM_BYTES, truncateUtf8Bytes } from "../app/lib/sql-text.ts";

// D1 (Cloudflare's SQLite) rejects a LIKE pattern over 50 UTF-8 bytes with
// "LIKE or GLOB pattern too complex" -- confirmed against production D1 with
// a real search term (ordinary SQLite has no such limit, so this cannot be
// exercised with a local sqlite3 connection). truncateUtf8Bytes() is what
// keeps `%${term}%` under that limit; MAX_LIKE_TERM_BYTES (48) is the largest
// term that still fits once wrapped in the two `%`.

test("MAX_LIKE_TERM_BYTES plus the two % wildcards is exactly the confirmed 50-byte limit", () => {
  expect(MAX_LIKE_TERM_BYTES + 2).toBe(50);
});

test("a short ASCII string is returned unchanged", () => {
  expect(truncateUtf8Bytes("hello", 48)).toBe("hello");
});

test("cuts at a byte boundary without splitting a multi-byte character", () => {
  // Each "愛" is 3 UTF-8 bytes; 20 of them is 60 bytes, over the 48-byte budget.
  const result = truncateUtf8Bytes("愛".repeat(20), 48);
  expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(48);
  expect(result).toBe("愛".repeat(16)); // 16 * 3 = 48 bytes exactly
  expect(result.includes("�")).toBe(false); // no replacement character from a split code point
});

test("does not split a surrogate pair (an emoji, 4 bytes in UTF-8)", () => {
  const result = truncateUtf8Bytes("😀".repeat(10), 7); // budget fits one emoji (4 bytes) but not two (8)
  expect(result).toBe("😀");
  expect([...result]).toHaveLength(1); // one whole code point, not half a surrogate pair
});

test("a string already under the budget, mixing ASCII and multi-byte characters, is untouched", () => {
  const value = "BSスペシャル";
  expect(truncateUtf8Bytes(value, MAX_LIKE_TERM_BYTES)).toBe(value);
});

test("the reported search term (27 chars, 71 UTF-8 bytes) is cut to fit the 48-byte budget", () => {
  const term = "BSスペシャル 禁じられる物語  愛国教育をめぐる攻防";
  expect(new TextEncoder().encode(term).length).toBe(71); // over the limit, as reported
  const result = truncateUtf8Bytes(term, MAX_LIKE_TERM_BYTES);
  expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(MAX_LIKE_TERM_BYTES);
  expect(term.startsWith(result)).toBe(true); // a prefix of the original, not a different string
});

test("an empty string and a zero budget both return empty", () => {
  expect(truncateUtf8Bytes("", 48)).toBe("");
  expect(truncateUtf8Bytes("hello", 0)).toBe("");
});
