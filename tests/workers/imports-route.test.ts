import { env } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { ensureSchema } from "@/db";
import { POST as importsPost } from "@/app/api/imports/route";

// POST /api/imports is how the daily TV-program automation adds items (source
// "tv-program", ~14 a day). The first block pins the behaviour that must not
// change; the second covers the preview image each imported item now gets.

beforeAll(async () => {
  await ensureSchema({ seed: false });
});

type ImportResult = { runId: string; total: number; created: number; errors: number; messages: Array<{ index: number; error: string }> };

async function importItems(items: unknown[], sourceName = "test-source") {
  const response = await importsPost(new Request("http://x/api/imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceName, items }) }));
  return { status: response.status, body: (await response.json()) as ImportResult & { error?: string } };
}

const item = (n: number, overrides: Record<string, unknown> = {}) => ({
  contentType: "movie", title: `imported ${n}`, creatorName: "NHK", seriesTitle: "series", externalId: `ext-${n}`, sourceSystem: "tv-program",
  links: [{ label: "NHK ONE", url: `https://noimage.example.org/p/${n}` }], ...overrides,
});

const row = (title: string) => env.DB.prepare("SELECT * FROM items WHERE title = ?").bind(title).first<Record<string, unknown>>();
const linksOf = async (itemId: string) => (await env.DB.prepare("SELECT label, url, canonical_url, position FROM item_links WHERE item_id = ? ORDER BY position").bind(itemId).all<Record<string, unknown>>()).results ?? [];

describe("imports (behaviour that must not change)", () => {
  test("creates items with their links and reports the counts", async () => {
    const { status, body } = await importItems([item(1, { links: [{ label: "A", url: "https://noimage.example.org/a?utm_source=x" }, { label: "B", url: "https://noimage.example.org/b" }] }), item(2)]);
    expect(status).toBe(201);
    expect(body).toMatchObject({ total: 2, created: 2, errors: 0, messages: [] });
    const first = await row("imported 1");
    expect(first).toMatchObject({ content_type: "movie", creator_name: "NHK", series_title: "series", source_system: "tv-program", external_id: "ext-1", version: 1 });
    expect(await linksOf(String(first!.id))).toEqual([
      { label: "A", url: "https://noimage.example.org/a?utm_source=x", canonical_url: "https://noimage.example.org/a", position: 0 },
      { label: "B", url: "https://noimage.example.org/b", canonical_url: "https://noimage.example.org/b", position: 1 },
    ]);
    const run = await env.DB.prepare("SELECT * FROM import_runs WHERE id = ?").bind(body.runId).first<Record<string, unknown>>();
    expect(run).toMatchObject({ source_name: "test-source", total_count: 2, created_count: 2, error_count: 0 });
  });

  test("skips an item whose external id is already imported, and a repeat within the same request", async () => {
    await importItems([item(10)]);
    const { status, body } = await importItems([item(10), item(11), item(11, { title: "imported 11 again" })]);
    expect(status).toBe(201); // skipped duplicates are messages, not errors
    expect(body.created).toBe(1);
    expect(body.messages.map((m) => m.index).sort()).toEqual([0, 2]);
    expect(body.messages.every((m) => m.error === "同じ外部IDのためスキップしました。")).toBe(true);
    expect(await row("imported 11 again")).toBeNull();
  });

  test("rejects an invalid item without failing the rest", async () => {
    const { status, body } = await importItems([item(20), { contentType: "movie" }, item(21)]);
    expect(status).toBe(207);
    expect(body).toMatchObject({ total: 3, created: 2, errors: 1 });
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].index).toBe(1);
  });

  test("400 without an items array, and above 200 items", async () => {
    const bad = await importsPost(new Request("http://x/api/imports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }));
    expect(bad.status).toBe(400);
    const big = await importItems(Array.from({ length: 201 }, (_, n) => item(1000 + n)));
    expect(big.status).toBe(400);
  });

  test("an item's links are saved together with it across the batch boundary", async () => {
    // 60 items x (1 item + 2 links) = 180 statements: several D1 batches of 50.
    const { body } = await importItems(Array.from({ length: 60 }, (_, n) => item(2000 + n, { links: [{ url: `https://noimage.example.org/x/${n}` }, { url: `https://noimage.example.org/y/${n}` }] })));
    expect(body.created).toBe(60);
    const orphans = await env.DB.prepare("SELECT COUNT(*) AS n FROM items i WHERE i.external_id GLOB 'ext-20[0-9][0-9]' AND (SELECT COUNT(*) FROM item_links l WHERE l.item_id = i.id) <> 2").first<{ n: number }>();
    expect(orphans?.n).toBe(0);
  });
});

describe("imports save each item with its preview image", () => {
  const thumbOf = async (title: string) => (await row(title))?.thumbnail_url;

  test("stores the page's og:image for a non-YouTube link, and nothing for a page without one", async () => {
    const { body } = await importItems([
      item(3000, { links: [{ url: "https://blog.example.org/post" }] }),
      item(3001, { links: [{ url: "https://noimage.example.org/a" }] }),
      item(3002, { links: [{ url: "https://unreachable.example.org/a" }] }),
    ]);
    expect(body.created).toBe(3);
    expect(await thumbOf("imported 3000")).toBe("https://blog.example.org/img/cover.png");
    expect(await thumbOf("imported 3001")).toBe("");
    expect(await thumbOf("imported 3002")).toBe(""); // an unreachable page never fails the import
  });

  test("a YouTube link stores nothing (its thumbnail is derived on read)", async () => {
    await importItems([item(3010, { links: [{ url: "https://www.youtube.com/watch?v=ftcDTWIT6ho" }] })]);
    expect(await thumbOf("imported 3010")).toBe("");
  });

  test("uses the next link when the first has no image", async () => {
    await importItems([item(3020, { links: [{ url: "https://noimage.example.org/a" }, { url: "https://blog.example.org/post" }] })]);
    expect(await thumbOf("imported 3020")).toBe("https://blog.example.org/img/cover.png");
  });

  test("follows a t.co-style meta-refresh page to the target's image", async () => {
    await importItems([item(3030, { links: [{ url: "https://short.example.org/abc" }] })]);
    expect(await thumbOf("imported 3030")).toBe("https://blog.example.org/img/cover.png");
  });

  test("does not follow a meta refresh to an internal address, and gives up on a refresh loop", async () => {
    await importItems([item(3040, { links: [{ url: "https://refresh-internal.example.org/x" }] }), item(3041, { links: [{ url: "https://loop.example.org/x" }] })]);
    expect(await thumbOf("imported 3040")).toBe("");
    expect(await thumbOf("imported 3041")).toBe("");
  });

  test("looks up at most 16 items per request and says how many were skipped", async () => {
    const { body } = await importItems(Array.from({ length: 20 }, (_, n) => item(3100 + n, { links: [{ url: "https://blog.example.org/post" }] })));
    expect(body.created).toBe(20);
    expect((body as unknown as { thumbnails: unknown }).thumbnails).toEqual({ looked: 16, found: 16, skipped: 4 });
    const withThumb = (await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE external_id GLOB 'ext-31[0-9][0-9]' AND thumbnail_url <> ''").first<{ n: number }>())?.n;
    expect(withThumb).toBe(16);
    // Which ones: the first 16 in payload order.
    expect(await thumbOf("imported 3115")).not.toBe("");
    expect(await thumbOf("imported 3116")).toBe("");
  });

  test("the response reports the lookups", async () => {
    const { body } = await importItems([item(3200, { links: [{ url: "https://blog.example.org/post" }] }), item(3201, { links: [{ url: "https://noimage.example.org/a" }] })]);
    expect((body as unknown as { thumbnails: unknown }).thumbnails).toEqual({ looked: 2, found: 1, skipped: 0 });
  });
});
