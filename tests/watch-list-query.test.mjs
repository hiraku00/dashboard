import { expect, test } from "vitest";

import { buildItemsFilter, ITEMS_ORDER_BY, toItem } from "../app/lib/watch-list-query.ts";

// buildItemsFilter() is the pure "which WHERE clause and binds does this
// request produce" decision extracted out of listItems() so it can be tested
// without a D1 binding. app/api/items/route.ts (GET) and the Watch List
// page's future Server Component both go through listItems(), so a bug here
// would silently make the two disagree on what "the list" contains.

test("defaults to only non-deleted rows with no filters", () => {
  const filter = buildItemsFilter({});
  expect(filter.where).toBe("WHERE deleted_at IS NULL");
  expect(filter.values).toEqual([]);
  expect(filter.limit).toBe(50);
  expect(filter.offset).toBe(0);
});

test("include_deleted drops the deleted_at clause entirely, not just widens it", () => {
  const filter = buildItemsFilter({ includeDeleted: true });
  expect(filter.where).toBe("");
  expect(filter.values).toEqual([]);
});

test("q searches title/description/creator/series and the links' url/label with the same wildcarded term", () => {
  const filter = buildItemsFilter({ q: "steth" });
  expect(filter.where).toBe("WHERE deleted_at IS NULL AND (title LIKE ? OR description LIKE ? OR creator_name LIKE ? OR series_title LIKE ? OR EXISTS (SELECT 1 FROM item_links l WHERE l.item_id = items.id AND (l.url LIKE ? OR l.label LIKE ?)))");
  expect(filter.values).toEqual(Array(6).fill("%steth%"));
});

test("a search term longer than D1's LIKE pattern limit is cut to fit, rather than making the query fail", () => {
  // D1 (Cloudflare's SQLite) rejects a LIKE pattern over 50 UTF-8 bytes with "LIKE
  // or GLOB pattern too complex" -- confirmed against production D1. This term (27
  // chars, 71 UTF-8 bytes) reproduced the report: the search silently failed and
  // app/watch-list-app.tsx showed "一覧を読み込めませんでした".
  const term = "BSスペシャル 禁じられる物語  愛国教育をめぐる攻防";
  const filter = buildItemsFilter({ q: term });
  const pattern = filter.values[0];
  expect(new TextEncoder().encode(pattern).length).toBeLessThanOrEqual(50);
  expect(term.startsWith(pattern.slice(1, -1))).toBe(true); // still a prefix match, not silently dropped
  expect(filter.values.every((value) => value === pattern)).toBe(true); // every LIKE gets the same, safe term
});

test("the link match is an EXISTS on an aliased table, so it neither duplicates an item nor clashes with listItems()'s links query", () => {
  const { where } = buildItemsFilter({ q: "x" });
  expect(where).toContain("EXISTS (SELECT 1 FROM item_links l WHERE l.item_id = items.id");
  expect(where).not.toMatch(/JOIN/i);
});

test("an unrecognized content type or status is dropped rather than passed through to SQL", () => {
  const filter = buildItemsFilter({ type: "not-a-real-type", status: "not-a-real-status" });
  expect(filter.where).toBe("WHERE deleted_at IS NULL");
  expect(filter.values).toEqual([]);
});

test("a recognized content type and status both apply, combined with AND", () => {
  const filter = buildItemsFilter({ type: "movie", status: "completed" });
  expect(filter.where).toBe("WHERE deleted_at IS NULL AND content_type = ? AND status = ?");
  expect(filter.values).toEqual(["movie", "completed"]);
});

test("creator is matched by exact value, not LIKE -- it comes from a dropdown of existing values", () => {
  const filter = buildItemsFilter({ creator: "任天堂" });
  expect(filter.where).toBe("WHERE deleted_at IS NULL AND creator_name = ?");
  expect(filter.values).toEqual(["任天堂"]);
});

test("limit is clamped to [1, 100] and offset to [0, +inf)", () => {
  expect(buildItemsFilter({ limit: 0 }).limit).toBe(1);
  expect(buildItemsFilter({ limit: 500 }).limit).toBe(100);
  expect(buildItemsFilter({ limit: -5 }).limit).toBe(1);
  expect(buildItemsFilter({ offset: -10 }).offset).toBe(0);
  expect(buildItemsFilter({ offset: 40 }).offset).toBe(40);
});

test("a missing limit/offset falls back to the same defaults as an explicit undefined", () => {
  const bare = buildItemsFilter();
  expect(bare.limit).toBe(50);
  expect(bare.offset).toBe(0);
});

test("q, creator and other free-text fields are trimmed and length-capped like clean() elsewhere", () => {
  const filter = buildItemsFilter({ q: "  padded  " });
  expect(filter.values).toEqual(Array(6).fill("%padded%"));
});

// toItem() maps a raw D1 row (snake_case columns) plus its links into the
// camelCase shape the API and the page both render. This is the same mapping
// tests/rendered-html.test.mjs could only check existed by grepping the
// source; here it is checked against actual input/output.

test("toItem maps snake_case D1 columns to the camelCase API shape", () => {
  const row = {
    id: "item-1", content_type: "movie", creator_name: "Studio", series_title: "Series",
    title: "Title", description: "Desc", priority: 3, status: "completed",
    added_on: "2026-01-01", watched_on: "2026-01-05", comment: "memo",
    source_system: "manual", external_id: null, version: 2,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-05T00:00:00Z",
  };
  const links = [{ id: "link-1", label: "公式", url: "https://example.com", link_type: "reference", position: 0 }];
  const item = toItem(row, links);
  expect(item.id).toBe("item-1");
  expect(item.contentType).toBe("movie");
  expect(item.creatorName).toBe("Studio");
  expect(item.seriesTitle).toBe("Series");
  expect(item.addedOn).toBe("2026-01-01");
  expect(item.watchedOn).toBe("2026-01-05");
  expect(item.version).toBe(2);
  expect(item.links).toEqual([{ id: "link-1", label: "公式", url: "https://example.com", linkType: "reference", position: 0 }]);
});

test("toItem returns an empty links array for a row with no links, not undefined", () => {
  const item = toItem({ id: "item-2" }, []);
  expect(item.links).toEqual([]);
});

// The list's sort must end in a unique key. Without one, LIMIT/OFFSET pages can
// repeat or skip items that tie on added_on and created_at (a bulk import stamps
// them alike), and listItems()'s links subquery can pick different rows than
// the page query. See tests/workers/watch-list-list.test.ts for the D1 side.
test("the list order ends in the id, after the date keys", () => {
  expect(ITEMS_ORDER_BY).toBe("ORDER BY added_on IS NULL ASC, added_on DESC, created_at DESC, id ASC");
});
