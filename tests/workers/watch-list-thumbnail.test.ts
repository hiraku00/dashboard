import { env } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { ensureSchema } from "@/db";
import { POST as itemsPost } from "@/app/api/items/route";
import { PATCH as itemPatch } from "@/app/api/items/[id]/route";

// Watch List thumbnails, end to end against a real D1 with the outbound
// fetches mocked (see tests/workers/fixtures/outbound-mocks.ts). The pure
// decisions are covered in tests/thumbnail.test.mjs; this checks what only a
// real route + D1 can: what gets stored on save, what is NOT refetched, and
// that a hostile link cannot make the Worker reach an internal host.

beforeAll(async () => {
  await ensureSchema({ seed: false });
});

type Saved = { id: string; version: number; thumbnailUrl: string };

async function save(url: string, body: Record<string, unknown>, id?: string) {
  const response = id
    ? await itemPatch(new Request(`http://x/api/items/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
    : await itemsPost(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  expect(response.status).toBe(id ? 200 : 201);
  return ((await response.json()) as { item: Saved }).item;
}

const create = (title: string, urls: string[]) => save("http://x/api/items", { contentType: "text", title, links: urls.map((url) => ({ url })) });
const storedThumbnail = async (id: string) => (await env.DB.prepare("SELECT thumbnail_url FROM items WHERE id = ?").bind(id).first<{ thumbnail_url: string }>())?.thumbnail_url;

describe("thumbnail on save", () => {
  test("stores the page's og:image, resolved against the page URL", async () => {
    const item = await create("blog post", ["https://blog.example.org/post"]);
    expect(item.thumbnailUrl).toBe("https://blog.example.org/img/cover.png");
    expect(await storedThumbnail(item.id)).toBe("https://blog.example.org/img/cover.png");
  });

  test("follows a redirect to a public page", async () => {
    const item = await create("redirected", ["https://hop.example.org/short"]);
    expect(item.thumbnailUrl).toBe("https://blog.example.org/img/cover.png");
  });

  test("does not follow a redirect to an internal address", async () => {
    const item = await create("sneaky", ["https://sneaky.example.org/go"]);
    expect(item.thumbnailUrl).toBe("");
  });

  test("does not fetch a link that points at an internal address", async () => {
    const item = await create("internal link", ["http://192.168.0.1/admin"]);
    expect(item.thumbnailUrl).toBe("");
  });

  test("leaves the thumbnail empty for a page with no image, and for an unreachable one", async () => {
    expect((await create("no image", ["https://noimage.example.org/a"])).thumbnailUrl).toBe("");
    expect((await create("unreachable", ["https://unreachable.example.org/a"])).thumbnailUrl).toBe("");
  });

  test("falls back to the next link when the first has no image", async () => {
    const item = await create("second link", ["https://noimage.example.org/a", "https://blog.example.org/post"]);
    expect(item.thumbnailUrl).toBe("https://blog.example.org/img/cover.png");
  });

  test("an item with a YouTube link gets the derived thumbnail and stores nothing", async () => {
    const item = await create("video", ["https://www.youtube.com/watch?v=ftcDTWIT6ho", "https://blog.example.org/post"]);
    expect(item.thumbnailUrl).toBe("https://i.ytimg.com/vi/ftcDTWIT6ho/mqdefault.jpg");
    expect(await storedThumbnail(item.id)).toBe("");
  });

  test("ignores a thumbnailUrl sent by the client", async () => {
    const item = await save("http://x/api/items", { contentType: "text", title: "spoofed", thumbnailUrl: "https://evil.example.net/x.png", links: [{ url: "https://noimage.example.org/a" }] });
    expect(item.thumbnailUrl).toBe("");
  });
});

describe("thumbnail on PATCH", () => {
  test("keeps the stored thumbnail when the links did not change", async () => {
    const item = await create("keep", ["https://blog.example.org/post"]);
    // Overwrite it with a marker: a refetch would put the og:image back.
    await env.DB.prepare("UPDATE items SET thumbnail_url = ? WHERE id = ?").bind("https://marker.example.org/kept.png", item.id).run();
    const patched = await save("", { contentType: "text", title: "keep", status: "in_progress", version: item.version, links: [{ url: "https://blog.example.org/post" }] }, item.id);
    expect(patched.thumbnailUrl).toBe("https://marker.example.org/kept.png");
  });

  test("looks the thumbnail up again when the links changed, and clears it when there is no image", async () => {
    const item = await create("change", ["https://noimage.example.org/a"]);
    const gained = await save("", { contentType: "text", title: "change", version: item.version, links: [{ url: "https://blog.example.org/post" }] }, item.id);
    expect(gained.thumbnailUrl).toBe("https://blog.example.org/img/cover.png");
    const lost = await save("", { contentType: "text", title: "change", version: gained.version, links: [{ url: "https://noimage.example.org/a" }] }, item.id);
    expect(lost.thumbnailUrl).toBe("");
    expect(await storedThumbnail(item.id)).toBe("");
  });
});
