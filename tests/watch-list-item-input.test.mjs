import assert from "node:assert/strict";
import test from "node:test";

import { normalizeItem } from "../app/lib/watch-list-item-input.ts";

// normalizeItem() is the pure "is this a valid Watch List item, and what does
// it normalize to" decision that app/api/items/route.ts's POST and
// app/api/items/[id]/route.ts's PATCH both go through (via the re-export in
// app/api/items/route.ts). A bug here would silently make new items and
// edited items validate differently.

test("rejects a non-object body", () => {
  assert.equal(normalizeItem(null).error, "JSONオブジェクトを指定してください。");
  assert.equal(normalizeItem("nope").error, "JSONオブジェクトを指定してください。");
});

test("requires a recognized contentType", () => {
  const result = normalizeItem({ contentType: "podcast", title: "t" });
  assert.equal(result.error, "種別は text / audio / movie / other のいずれかです。");
});

test("defaults status to backlog when omitted", () => {
  const result = normalizeItem({ contentType: "movie", title: "t" });
  assert.equal(result.value?.status, "backlog");
});

test("rejects an unrecognized status", () => {
  const result = normalizeItem({ contentType: "movie", title: "t", status: "archived" });
  assert.equal(result.error, "ステータスが不正です。");
});

test("requires a non-empty title", () => {
  const result = normalizeItem({ contentType: "movie", title: "  " });
  assert.equal(result.error, "タイトルは必須です。");
});

test("rejects a malformed addedOn/watchedOn date", () => {
  const result = normalizeItem({ contentType: "movie", title: "t", addedOn: "2026/01/01" });
  assert.equal(result.error, "日付は YYYY-MM-DD 形式で指定してください。");
});

test("only validates watchedOn when status is completed", () => {
  // A malformed watchedOn is ignored for a non-completed item -- it gets
  // cleared to "" before the date check, mirroring the pre-existing
  // behaviour of app/api/items/route.ts's original normalizeItem().
  const result = normalizeItem({ contentType: "movie", title: "t", status: "backlog", watchedOn: "not-a-date" });
  assert.equal(result.value?.watchedOn, null);
});

test("rejects a priority outside 1-5", () => {
  assert.equal(normalizeItem({ contentType: "movie", title: "t", priority: 0 }).error, "優先度は1〜5で指定してください。");
  assert.equal(normalizeItem({ contentType: "movie", title: "t", priority: 6 }).error, "優先度は1〜5で指定してください。");
  assert.equal(normalizeItem({ contentType: "movie", title: "t", priority: 2.5 }).error, "優先度は1〜5で指定してください。");
});

test("priority null/undefined/empty-string all normalize to null", () => {
  assert.equal(normalizeItem({ contentType: "movie", title: "t", priority: null }).value?.priority, null);
  assert.equal(normalizeItem({ contentType: "movie", title: "t", priority: undefined }).value?.priority, null);
  assert.equal(normalizeItem({ contentType: "movie", title: "t", priority: "" }).value?.priority, null);
});

test("drops links with no url, keeps ones with a url", () => {
  const result = normalizeItem({
    contentType: "movie",
    title: "t",
    links: [{ label: "empty" }, { label: "ok", url: "https://example.com" }],
  });
  assert.equal(result.value?.links.length, 1);
  assert.equal(result.value?.links[0].url, "https://example.com");
});

test("rejects a link whose url the URL constructor cannot parse at all", () => {
  const result = normalizeItem({ contentType: "movie", title: "t", links: [{ url: "not a url" }] });
  assert.equal(result.error, "リンクには http または https のURLを指定してください。");
});

test("rejects a link whose url has a non-http(s) scheme", () => {
  // canonicalUrl()'s protocol check (see Issue #74 and shared-helpers.test.mjs)
  // is what makes this rejected rather than silently accepted -- the URL
  // constructor itself does not throw on "javascript:" or "data:" URIs.
  const result = normalizeItem({ contentType: "movie", title: "t", links: [{ url: "javascript:alert(1)" }] });
  assert.equal(result.error, "リンクには http または https のURLを指定してください。");
});

test("rejects two links on the same item that canonicalize to the same destination", () => {
  // Same scope as item_links_canonical_idx (UNIQUE on (item_id,
  // canonical_url), not global -- see Issue #76 and db/index.ts). A link
  // with a tracking param and the "same" link without one both canonicalize
  // to the same URL, so this must be caught before either the DB or that
  // index sees it as duplicate INSERTs within one item's own batch.
  const result = normalizeItem({
    contentType: "movie",
    title: "t",
    links: [
      { label: "A", url: "https://example.com/x?utm_source=a" },
      { label: "B", url: "https://example.com/x" },
    ],
  });
  assert.equal(result.error, "同じリンクが重複しています。");
});

test("does not reject the same canonical destination reused across separately-normalized items", () => {
  // The dedup check is per-call (i.e. per-item): normalizeItem() has no
  // memory of other items' links, matching item_links_canonical_idx's
  // per-item_id scope -- many different items are allowed to legitimately
  // share one destination (e.g. a series-archive page linked from every
  // episode's item; see the migration comment in
  // migrations/0007_item_links_canonical_idx.sql for the production
  // evidence behind this).
  const first = normalizeItem({ contentType: "movie", title: "t1", links: [{ url: "https://example.com/series" }] });
  const second = normalizeItem({ contentType: "movie", title: "t2", links: [{ url: "https://example.com/series" }] });
  assert.equal(first.error, undefined);
  assert.equal(second.error, undefined);
});

test("a missing linkType defaults to 'reference'", () => {
  const result = normalizeItem({ contentType: "movie", title: "t", links: [{ url: "https://example.com" }] });
  assert.equal(result.value?.links[0].linkType, "reference");
});

test("sourceSystem defaults to 'manual' when omitted or blank", () => {
  assert.equal(normalizeItem({ contentType: "movie", title: "t" }).value?.sourceSystem, "manual");
  assert.equal(normalizeItem({ contentType: "movie", title: "t", sourceSystem: "" }).value?.sourceSystem, "manual");
});

test("returns a full normalized value for a valid item", () => {
  const result = normalizeItem({
    contentType: "text",
    creatorName: "  NHK  ",
    title: "タイトル",
    status: "completed",
    watchedOn: "2026-01-05",
    priority: 3,
  });
  assert.deepEqual(result.value, {
    contentType: "text",
    creatorName: "NHK",
    seriesTitle: "",
    title: "タイトル",
    description: "",
    priority: 3,
    status: "completed",
    addedOn: null,
    watchedOn: "2026-01-05",
    comment: "",
    sourceSystem: "manual",
    externalId: null,
    rawSource: null,
    links: [],
  });
});
