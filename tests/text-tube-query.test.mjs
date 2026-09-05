import assert from "node:assert/strict";
import test from "node:test";

import { buildVideosFilter } from "../app/lib/text-tube-query.ts";

// buildVideosFilter() is the pure "which WHERE clause and binds does this
// request produce" decision extracted out of listVideos() so it can be
// tested without a D1 binding. app/api/text-tube/videos/route.ts (GET) and
// the /text-tube and /text-tube/studio pages' future Server Components all
// go through listVideos(), so a bug here would silently make them disagree
// on what "the list" contains.

test("with no query, only excludes deleted rows", () => {
  const filter = buildVideosFilter({});
  assert.equal(filter.where, "WHERE deleted_at IS NULL");
  assert.deepEqual(filter.values, []);
});

test("a missing query object defaults the same as an empty one", () => {
  const filter = buildVideosFilter();
  assert.equal(filter.where, "WHERE deleted_at IS NULL");
  assert.deepEqual(filter.values, []);
});

test("q searches both title and channel_name with the same wildcarded term", () => {
  const filter = buildVideosFilter({ q: "steth" });
  assert.equal(filter.where, "WHERE deleted_at IS NULL AND (title LIKE ? OR channel_name LIKE ?)");
  assert.deepEqual(filter.values, ["%steth%", "%steth%"]);
});

test("q is trimmed and length-capped like clean() elsewhere", () => {
  const filter = buildVideosFilter({ q: "  padded  " });
  assert.deepEqual(filter.values, ["%padded%", "%padded%"]);
});

test("a blank or whitespace-only q behaves like no query at all", () => {
  assert.equal(buildVideosFilter({ q: "" }).where, "WHERE deleted_at IS NULL");
  assert.equal(buildVideosFilter({ q: "   " }).where, "WHERE deleted_at IS NULL");
  assert.equal(buildVideosFilter({ q: null }).where, "WHERE deleted_at IS NULL");
});
