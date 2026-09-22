/** Pure text helpers for building SQL, shared by watch-list-query.ts and
 *  text-tube-query.ts (server-side, the actual truncation before a LIKE
 *  query) and by watch-list-app.tsx / text-tube-app.tsx (client-side, so the
 *  search box itself refuses to hold more than the safe byte budget, rather
 *  than silently truncating whatever the user typed after the fact). No
 *  imports beyond the standard TextEncoder, which both Workers and every
 *  browser provide, so this loads under vitest's plain-Node "node" project
 *  the same way the two query-builder modules do, and bundles fine into the
 *  client components too. */

/** D1 (Cloudflare's SQLite) rejects a LIKE pattern longer than 50 UTF-8 bytes
 *  with "LIKE or GLOB pattern too complex" -- confirmed empirically against
 *  production D1 (not documented; ordinary SQLite has no such limit and a
 *  local better-sqlite3/node:sqlite check does not reproduce it). The limit is
 *  on bytes, not JS string length: `clean(query.q, 200)` truncates to 200
 *  UTF-16 code units, which for Japanese (3 bytes/char in UTF-8) reaches the
 *  50-byte pattern (`%term%`) at only ~16 characters. A search term past that
 *  made the whole query throw, which app/watch-list-app.tsx's catch block
 *  turns into "一覧を読み込めませんでした" and -- because a failed request
 *  leaves the previously-fetched items on screen (see refreshItems in
 *  app/watch-list-app.tsx) -- can look like the last successful, shorter-query
 *  fetch matched everything.
 *
 *  This truncates to at most `maxBytes` UTF-8 bytes without splitting a
 *  surrogate pair (iterating `for...of` walks a string by Unicode code point,
 *  not UTF-16 code unit), so the term used inside `%${term}%` always keeps
 *  the pattern within the limit while cutting the term as little as
 *  possible. */
export function truncateUtf8Bytes(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let bytes = 0;
  let result = "";
  for (const char of value) {
    bytes += encoder.encode(char).length;
    if (bytes > maxBytes) break;
    result += char;
  }
  return result;
}

/** The longest search term that keeps `%${term}%` at or under D1's 50-byte
 *  LIKE pattern limit (see truncateUtf8Bytes). */
export const MAX_LIKE_TERM_BYTES = 48;

/** UTF-8 byte length of `value` -- what a search box's live counter shows
 *  against MAX_LIKE_TERM_BYTES (an ASCII character is 1 byte, a Japanese
 *  character is typically 3, so the same-looking "16 characters left" would
 *  be misleading whenever the script mixes). */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
