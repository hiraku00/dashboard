import { expect, test } from "vitest";

import { buildVideosFilter, videosOffset, videosUnread } from "../app/lib/text-tube-query.ts";
import { listViewFromParams, listViewQuery } from "../app/lib/text-tube-list-view.ts";

// buildVideosFilter() is the pure "which WHERE clause and binds does this
// request produce" decision extracted out of listVideos() so it can be
// tested without a D1 binding. app/api/text-tube/videos/route.ts (GET) and
// the /text-tube page's Server Component both
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

test("a search term longer than D1's LIKE pattern limit is cut to fit, rather than making the query fail", () => {
  // Same D1 limit as watch-list-query.ts's equivalent test -- see sql-text.ts.
  const term = "BSスペシャル 禁じられる物語  愛国教育をめぐる攻防";
  const filter = buildVideosFilter({ q: term });
  const pattern = filter.values[0];
  expect(new TextEncoder().encode(pattern).length).toBeLessThanOrEqual(50);
  expect(term.startsWith(pattern.slice(1, -1))).toBe(true);
});

test("a blank or whitespace-only q behaves like no query at all", () => {
  expect(buildVideosFilter({ q: "" }).where).toBe("WHERE deleted_at IS NULL");
  expect(buildVideosFilter({ q: "   " }).where).toBe("WHERE deleted_at IS NULL");
  expect(buildVideosFilter({ q: null }).where).toBe("WHERE deleted_at IS NULL");
});

test("offset accepts a non-negative integer and treats anything else as the first page", () => {
  expect(videosOffset("100")).toBe(100);
  expect(videosOffset(200)).toBe(200);
  expect(videosOffset(" 7 ")).toBe(7);
  for (const bad of [null, undefined, "", "-1", "1.5", "abc", "1e3", -5, 2.5, Number.NaN, "99999999999999999999"]) {
    expect(videosOffset(bad)).toBe(0);
  }
});

test("unread adds the read_at condition, with and without a search term", () => {
  expect(buildVideosFilter({ unread: true }).where).toBe("WHERE deleted_at IS NULL AND read_at IS NULL");
  const both = buildVideosFilter({ q: "steth", unread: true });
  expect(both.where).toBe("WHERE deleted_at IS NULL AND read_at IS NULL AND (title LIKE ? OR channel_name LIKE ?)");
  expect(both.values).toEqual(["%steth%", "%steth%"]);
  expect(videosUnread("1")).toBe(true);
  for (const other of [null, undefined, "", "0", "true"]) expect(videosUnread(other)).toBe(false);
});

test("the list view round-trips through the URL query, leaving defaults out", () => {
  const defaults = listViewFromParams({});
  expect(defaults).toEqual({ q: "", sort: "created_at-desc", channel: "all", unread: false });
  expect(listViewQuery(defaults)).toBe("");

  const view = { q: "資本論", sort: "title-asc", channel: "COTEN RADIO", unread: true };
  const query = listViewQuery(view);
  expect(query.startsWith("?")).toBe(true);
  const parsed = Object.fromEntries(new URLSearchParams(query));
  expect(listViewFromParams(parsed)).toEqual(view);

  // An unknown sort falls back to the default instead of reaching the screen.
  expect(listViewFromParams({ sort: "drop table" }).sort).toBe("created_at-desc");
});
