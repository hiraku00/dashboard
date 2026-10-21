import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { ensureSchema } from "@/db";
import { listItems, watchListStats } from "@/app/lib/queries/watch-list";

// listItems() serves both GET /api/items and the Watch List page's first
// render. It fetches the page, the total and the page's links in ONE D1 batch
// (a D1 round trip costs far more than the SQL itself), which only works if
// the links subquery picks exactly the rows the page query does. These tests
// pin that against a real D1, including the case that would break it: items
// whose sort keys tie.

beforeAll(async () => {
  await ensureSchema({ seed: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Inserts straight into D1 so every row can share added_on and created_at, as
 *  a bulk import does. `tag` keeps this file's rows apart from other tests'. */
async function seed(tag: string, count: number, { added_on, created_at }: { added_on: string | null; created_at: string }) {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < count; i++) {
    const id = `${tag}-${String(i).padStart(3, "0")}`;
    statements.push(env.DB.prepare("INSERT INTO items (id, content_type, title, added_on, created_at, updated_at) VALUES (?, 'text', ?, ?, ?, ?)").bind(id, `${tag} title ${i}`, added_on, created_at, created_at));
    // Two links each, inserted out of order, so `position` ordering is observable.
    statements.push(env.DB.prepare("INSERT INTO item_links (id, item_id, label, url, position, canonical_url) VALUES (?, ?, 'second', ?, 1, ?)").bind(`${id}-b`, id, `https://example.org/${id}/b`, `https://example.org/${id}/b`));
    statements.push(env.DB.prepare("INSERT INTO item_links (id, item_id, label, url, position, canonical_url) VALUES (?, ?, 'first', ?, 0, ?)").bind(`${id}-a`, id, `https://example.org/${id}/a`, `https://example.org/${id}/a`));
  }
  await env.DB.batch(statements);
}

describe("listItems", () => {
  test("attaches each item's own links, in position order", async () => {
    await seed("links", 3, { added_on: "2020-01-01", created_at: "2020-01-01T00:00:00.000Z" });
    const { items } = await listItems({ q: "links title", limit: 10 });
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.links.map((link) => link.label)).toEqual(["first", "second"]);
      expect(item.links.map((link) => link.url)).toEqual([`https://example.org/${item.id}/a`, `https://example.org/${item.id}/b`]);
    }
  });

  test("pages through items with identical sort keys without repeating or skipping any", async () => {
    await seed("tie", 25, { added_on: "2021-05-05", created_at: "2021-05-05T00:00:00.000Z" });
    const seen: string[] = [];
    for (const offset of [0, 10, 20]) {
      const { items, pagination } = await listItems({ q: "tie title", limit: 10, offset });
      expect(pagination.total).toBe(25);
      for (const item of items) {
        // The links came from the same rows as the page, not a different tie order.
        expect(item.links).toHaveLength(2);
        expect(item.links.every((link) => String(link.url).includes(String(item.id)))).toBe(true);
        seen.push(String(item.id));
      }
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen).toEqual([...seen].sort());
  });

  test("puts items without an added date after dated ones", async () => {
    await seed("undated", 2, { added_on: null, created_at: "2022-02-02T00:00:00.000Z" });
    await seed("dated", 2, { added_on: "2019-01-01", created_at: "2019-01-01T00:00:00.000Z" });
    const { items } = await listItems({ limit: 100 });
    const ids = items.map((item) => String(item.id));
    const lastDated = Math.max(...ids.map((id, index) => (id.startsWith("dated-") ? index : -1)));
    const firstUndated = ids.findIndex((id) => id.startsWith("undated-"));
    expect(lastDated).toBeGreaterThanOrEqual(0);
    expect(firstUndated).toBeGreaterThan(lastDated);
  });

  test("makes a single D1 batch and no other query", async () => {
    await ensureSchema({ seed: false }); // the one-time schema check is not part of the list itself
    const batch = vi.spyOn(env.DB, "batch");
    const prepare = vi.spyOn(env.DB, "prepare");
    await listItems({ limit: 10 });
    expect(batch).toHaveBeenCalledTimes(1);
    // Four statements prepared (items, count, links, オプチャ threads for the
    // ちきりんオプチャ column), all handed to that one batch.
    expect(prepare).toHaveBeenCalledTimes(4);
    expect(batch.mock.calls[0][0]).toHaveLength(4);
  });
});

describe("listItems search (q)", () => {
  async function seedLinks(id: string, title: string, links: Array<{ url: string; label?: string }>) {
    const statements = [env.DB.prepare("INSERT INTO items (id, content_type, title, created_at, updated_at) VALUES (?, 'text', ?, '2023-03-03T00:00:00.000Z', '2023-03-03T00:00:00.000Z')").bind(id, title)];
    links.forEach((link, position) => statements.push(env.DB.prepare("INSERT INTO item_links (id, item_id, label, url, position, canonical_url) VALUES (?, ?, ?, ?, ?, ?)").bind(`${id}-${position}`, id, link.label ?? "", link.url, position, link.url)));
    await env.DB.batch(statements);
  }

  test("finds an item by a word in a link's URL, case-insensitively, and returns all of its links", async () => {
    await seedLinks("search-yt", "no keyword in this title", [{ url: "https://example.org/other" }, { url: "https://www.YouTube.com/watch?v=abcdefghijk" }]);
    await seedLinks("search-other", "another title", [{ url: "https://example.org/nothing" }]);
    const { items, pagination } = await listItems({ q: "youtube", limit: 100 });
    const ids = items.map((item) => String(item.id));
    expect(ids).toContain("search-yt");
    expect(ids).not.toContain("search-other");
    expect(pagination.total).toBe(items.length);
    // The non-matching link comes along too: the search picks the item, not the link.
    expect(items.find((item) => item.id === "search-yt")!.links).toHaveLength(2);
  });

  test("finds an item by a link's display name", async () => {
    await seedLinks("search-label", "plain title", [{ url: "https://example.org/a", label: "公式ページ" }]);
    const { items } = await listItems({ q: "公式ページ", limit: 100 });
    expect(items.map((item) => String(item.id))).toContain("search-label");
  });

  test("an item whose several links all match still appears once and is counted once", async () => {
    await seedLinks("search-multi", "multi", [{ url: "https://multi.example.org/1" }, { url: "https://multi.example.org/2" }, { url: "https://multi.example.org/3", label: "multi.example.org" }]);
    const { items, pagination } = await listItems({ q: "multi.example.org", limit: 100 });
    expect(items.filter((item) => item.id === "search-multi")).toHaveLength(1);
    expect(pagination.total).toBe(1);
  });

  test("still matches the text fields, and a term that matches nothing returns nothing", async () => {
    await seedLinks("search-title", "unique-title-zzz", []);
    expect((await listItems({ q: "unique-title-zzz" })).items.map((item) => String(item.id))).toEqual(["search-title"]);
    const none = await listItems({ q: "no-such-term-anywhere-qqq" });
    expect(none.items).toEqual([]);
    expect(none.pagination.total).toBe(0);
  });

  test("pages through link matches with a correct total", async () => {
    for (let i = 0; i < 12; i++) await seedLinks(`search-page-${String(i).padStart(2, "0")}`, `page ${i}`, [{ url: `https://paged.example.org/${i}` }]);
    const first = await listItems({ q: "paged.example.org", limit: 5, offset: 0 });
    const last = await listItems({ q: "paged.example.org", limit: 5, offset: 10 });
    expect(first.pagination).toMatchObject({ total: 12, hasMore: true });
    expect(first.items).toHaveLength(5);
    expect(last.items).toHaveLength(2);
    expect(last.pagination.hasMore).toBe(false);
    for (const item of [...first.items, ...last.items]) expect(item.links).toHaveLength(1);
  });
});

describe("watchListStats", () => {
  // 「人物・媒体」の絞り込みの選択肢は、以前は表示中のページの10件から作っていて、他のページにしかいない人物を選べなかった。
  // 選択肢は watchListStats() の creators(全件から)になったので、1ページに収まらない人数でそれを確かめる。
  test("counts by status and type in one aggregate, and lists every creator (not just one page's)", async () => {
    const before = await watchListStats();
    const statuses = ["backlog", "in_progress", "completed", "dropped"] as const;
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < 12; i++) {
      statements.push(env.DB.prepare("INSERT INTO items (id, content_type, creator_name, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '2024-04-04T00:00:00.000Z', '2024-04-04T00:00:00.000Z')")
        .bind(`stats-${i}`, i % 2 ? "audio" : "movie", `stats-creator-${String(i).padStart(2, "0")}`, `stats ${i}`, statuses[i % 4]));
    }
    // 空の人物と、削除済みの項目の人物は出さない(削除済みは件数にも入れない)。
    statements.push(env.DB.prepare("INSERT INTO items (id, content_type, creator_name, title, created_at, updated_at) VALUES ('stats-blank', 'text', '', 'blank', '2024-04-04T00:00:00.000Z', '2024-04-04T00:00:00.000Z')"));
    statements.push(env.DB.prepare("INSERT INTO items (id, content_type, creator_name, title, status, created_at, updated_at, deleted_at) VALUES ('stats-deleted', 'text', 'stats-deleted-creator', 'deleted', 'completed', '2024-04-04T00:00:00.000Z', '2024-04-04T00:00:00.000Z', '2024-04-05T00:00:00.000Z')"));
    await env.DB.batch(statements);

    const after = await watchListStats();
    expect(after.total - before.total).toBe(13);
    expect(after.movie - before.movie).toBe(6);
    expect(after.audio - before.audio).toBe(6);
    expect(after.text - before.text).toBe(1);
    expect(after.completed - before.completed).toBe(3);
    expect({
      backlog: after.byStatus.backlog - before.byStatus.backlog, in_progress: after.byStatus.in_progress - before.byStatus.in_progress,
      completed: after.byStatus.completed - before.byStatus.completed, dropped: after.byStatus.dropped - before.byStatus.dropped,
    }).toEqual({ backlog: 4, in_progress: 3, completed: 3, dropped: 3 });
    expect(after.completed).toBe(after.byStatus.completed);
    expect(after.byStatus.backlog + after.byStatus.in_progress + after.byStatus.completed + after.byStatus.dropped).toBe(after.total);

    const seeded = after.creators.filter((name) => name.startsWith("stats-"));
    expect(seeded).toEqual(Array.from({ length: 12 }, (_, i) => `stats-creator-${String(i).padStart(2, "0")}`));
    expect(after.creators).not.toContain("");
    expect(after.creators).not.toContain("stats-deleted-creator");
    expect(new Set(after.creators).size).toBe(after.creators.length);
  });

  test("makes a single D1 batch of two statements", async () => {
    await ensureSchema({ seed: false });
    const batch = vi.spyOn(env.DB, "batch");
    await watchListStats();
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toHaveLength(2);
  });
});
