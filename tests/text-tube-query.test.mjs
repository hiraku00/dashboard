import { expect, test } from "vitest";

import { buildVideosFilter } from "../app/lib/text-tube-query.ts";

// buildVideosFilter() is the pure "which WHERE clause and binds does this
// request produce" decision extracted out of listVideos() so it can be
// tested without a D1 binding. app/api/text-tube/videos/route.ts (GET) and
// the /text-tube and /text-tube/studio pages' future Server Components all
// go through listVideos(), so a bug here would silently make them disagree
// on what "the list" contains.

test("with no query, only excludes deleted rows", () => {
  const filter = buildVideosFilter({});
  expect(filter.where).toBe("WHERE deleted_at IS NULL");
  expect(filter.values).toEqual([]);
});

test("a missing query object defaults the same as an empty one", () => {
  const filter = buildVideosFilter();
  expect(filter.where).toBe("WHERE deleted_at IS NULL");
  expect(filter.values).toEqual([]);
});

test("q searches both title and channel_name with the same wildcarded term", () => {
  const filter = buildVideosFilter({ q: "steth" });
  expect(filter.where).toBe("WHERE deleted_at IS NULL AND (title LIKE ? OR channel_name LIKE ?)");
  expect(filter.values).toEqual(["%steth%", "%steth%"]);
});

test("q is trimmed and length-capped like clean() elsewhere", () => {
  const filter = buildVideosFilter({ q: "  padded  " });
  expect(filter.values).toEqual(["%padded%", "%padded%"]);
});

test("a blank or whitespace-only q behaves like no query at all", () => {
  expect(buildVideosFilter({ q: "" }).where).toBe("WHERE deleted_at IS NULL");
  expect(buildVideosFilter({ q: "   " }).where).toBe("WHERE deleted_at IS NULL");
  expect(buildVideosFilter({ q: null }).where).toBe("WHERE deleted_at IS NULL");
});
