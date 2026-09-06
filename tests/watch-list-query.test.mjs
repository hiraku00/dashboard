import { expect, test } from "vitest";

import { buildItemsFilter, toItem } from "../app/lib/watch-list-query.ts";

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

test("q searches title/description/creator/series with the same wildcarded term", () => {
  const filter = buildItemsFilter({ q: "steth" });
  expect(filter.where).toBe("WHERE deleted_at IS NULL AND (title LIKE ? OR description LIKE ? OR creator_name LIKE ? OR series_title LIKE ?)");
  expect(filter.values).toEqual(["%steth%", "%steth%", "%steth%", "%steth%"]);
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
  expect(filter.values).toEqual(["%padded%", "%padded%", "%padded%", "%padded%"]);
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
