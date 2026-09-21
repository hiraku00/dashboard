import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { ensureSchema } from "@/db";
import { listItems } from "@/app/lib/queries/watch-list";

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
    // Three statements prepared, all handed to that one batch.
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(batch.mock.calls[0][0]).toHaveLength(3);
  });
});
