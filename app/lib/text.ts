/** Small string/URL helpers shared by the API routes that accept user input.
 *  These were duplicated near-verbatim in app/lib/portal.ts, app/api/items/route.ts
 *  and app/api/todos/_lib.ts (clean/validDate identical in all three), and
 *  canonicalUrl existed in three different forms with three different rules
 *  (items/route.ts stripped tracking params, app/api/imports/route.ts and the
 *  db/index.ts seed loop stripped only the hash) -- so a URL imported or seeded
 *  could get a different canonical_url than the same URL posted through
 *  /api/items, silently breaking the item_links_canonical_idx dedup between
 *  those paths. */

export function clean(value: unknown, max = 4000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function validDate(value: string) {
  return !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Strips the fragment and known tracking params (utm_*, fbclid) so the same
 *  destination canonicalizes the same way regardless of how a link arrived
 *  (manual entry, YouTube import, or the initial seed).
 *
 *  Returns "" -- which every caller treats as "not a valid link" -- for
 *  anything the URL constructor cannot parse AND for any scheme other than
 *  http/https. That second check used to be missing: `new URL()` happily
 *  accepts "javascript:alert(1)" or "data:..." without throwing, so a link
 *  with such a scheme passed straight through despite
 *  app/lib/watch-list-item-input.ts's error message claiming "http または
 *  https のURLを指定してください". See tests/watch-list-item-input.test.mjs
 *  for the case this guards against. */
export function canonicalUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || key === "fbclid") url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}
