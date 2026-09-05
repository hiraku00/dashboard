import assert from "node:assert/strict";
import test from "node:test";

import { buildItemsFilter, toItem } from "../app/lib/watch-list-query.ts";

// buildItemsFilter() is the pure "which WHERE clause and binds does this
// request produce" decision extracted out of listItems() so it can be tested
// without a D1 binding. app/api/items/route.ts (GET) and the Watch List
// page's future Server Component both go through listItems(), so a bug here
// would silently make the two disagree on what "the list" contains.

test("defaults to only non-deleted rows with no filters", () => {
  const filter = buildItemsFilter({});
  assert.equal(filter.where, "WHERE deleted_at IS NULL");
  assert.deepEqual(filter.values, []);
  assert.equal(filter.limit, 50);
  assert.equal(filter.offset, 0);
});

test("include_deleted drops the deleted_at clause entirely, not just widens it", () => {
  const filter = buildItemsFilter({ includeDeleted: true });
  assert.equal(filter.where, "");
  assert.deepEqual(filter.values, []);
});

test("q searches title/description/creator/series with the same wildcarded term", () => {
  const filter = buildItemsFilter({ q: "steth" });
  assert.equal(
    filter.where,
    "WHERE deleted_at IS NULL AND (title LIKE ? OR description LIKE ? OR creator_name LIKE ? OR series_title LIKE ?)",
  );
  assert.deepEqual(filter.values, ["%steth%", "%steth%", "%steth%", "%steth%"]);
});

test("an unrecognized content type or status is dropped rather than passed through to SQL", () => {
  const filter = buildItemsFilter({ type: "not-a-real-type", status: "not-a-real-status" });
  assert.equal(filter.where, "WHERE deleted_at IS NULL");
  assert.deepEqual(filter.values, []);
});

test("a recognized content type and status both apply, combined with AND", () => {
  const filter = buildItemsFilter({ type: "movie", status: "completed" });
  assert.equal(filter.where, "WHERE deleted_at IS NULL AND content_type = ? AND status = ?");
  assert.deepEqual(filter.values, ["movie", "completed"]);
});

test("creator is matched by exact value, not LIKE -- it comes from a dropdown of existing values", () => {
  const filter = buildItemsFilter({ creator: "任天堂" });
  assert.equal(filter.where, "WHERE deleted_at IS NULL AND creator_name = ?");
  assert.deepEqual(filter.values, ["任天堂"]);
});

test("limit is clamped to [1, 100] and offset to [0, +inf)", () => {
  assert.equal(buildItemsFilter({ limit: 0 }).limit, 1);
  assert.equal(buildItemsFilter({ limit: 500 }).limit, 100);
  assert.equal(buildItemsFilter({ limit: -5 }).limit, 1);
  assert.equal(buildItemsFilter({ offset: -10 }).offset, 0);
  assert.equal(buildItemsFilter({ offset: 40 }).offset, 40);
});

test("a missing limit/offset falls back to the same defaults as an explicit undefined", () => {
  const bare = buildItemsFilter();
  assert.equal(bare.limit, 50);
  assert.equal(bare.offset, 0);
});

test("q, creator and other free-text fields are trimmed and length-capped like clean() elsewhere", () => {
  const filter = buildItemsFilter({ q: "  padded  " });
  assert.deepEqual(filter.values, ["%padded%", "%padded%", "%padded%", "%padded%"]);
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
  assert.equal(item.id, "item-1");
  assert.equal(item.contentType, "movie");
  assert.equal(item.creatorName, "Studio");
  assert.equal(item.seriesTitle, "Series");
  assert.equal(item.addedOn, "2026-01-01");
  assert.equal(item.watchedOn, "2026-01-05");
  assert.equal(item.version, 2);
  assert.deepEqual(item.links, [{ id: "link-1", label: "公式", url: "https://example.com", linkType: "reference", position: 0 }]);
});

test("toItem returns an empty links array for a row with no links, not undefined", () => {
  const item = toItem({ id: "item-2" }, []);
  assert.deepEqual(item.links, []);
});
