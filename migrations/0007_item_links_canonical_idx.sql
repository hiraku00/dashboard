-- Adds the item_links_canonical_idx that app/lib/text.ts, app/api/imports/route.ts
-- and db/index.ts have referenced in comments since canonicalUrl() was
-- unified across call sites, but that was never actually created (Issue #76).
--
-- Scoped to (item_id, canonical_url), not canonical_url alone: production
-- data has many different items legitimately sharing one canonical_url (a
-- shared series-archive page linked from every episode's item) -- a global
-- unique index on canonical_url would have rejected those. Verified against
-- production before writing this migration:
--   - 0 rows violate UNIQUE(item_id, canonical_url)
--   - 74 groups / 159 rows would violate a global UNIQUE(canonical_url)
-- confirming the per-item scope is correct and this migration applies
-- cleanly with no cleanup step needed first.
--
-- app/lib/watch-list-item-input.ts's normalizeItem() now also rejects a
-- duplicate canonical_url within one item's own links at the application
-- layer (with a proper Japanese error message), so this index should only
-- ever be a backstop, not the first thing a duplicate hits.

CREATE UNIQUE INDEX IF NOT EXISTS item_links_canonical_idx
  ON item_links(item_id, canonical_url);
