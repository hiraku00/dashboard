import { env } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { ensureSchema } from "@/db";
import { GET as itemsGet, POST as itemsPost } from "@/app/api/items/route";
import { PATCH as itemPatch } from "@/app/api/items/[id]/route";

// This is the first test in the new @cloudflare/vitest-pool-workers tier
// (Issue #80, Stage 1) -- it runs inside a real workerd instance with a real
// (ephemeral) D1, importing the actual route handlers rather than mocking
// them. It exists to give automated coverage to two things that, until now,
// were only verified by hand against `wrangler dev --local` during their own
// PRs:
//
// - Issue #75's per-route optimistic-lock fix (UPDATE ... WHERE version=?,
//   checked via result.meta.changes rather than a separate SELECT-then-
//   compare) -- see app/api/items/[id]/route.ts.
// - Issue #76's item_links_canonical_idx (UNIQUE on (item_id,
//   canonical_url), not on canonical_url alone) and the matching
//   application-layer duplicate check in
//   app/lib/watch-list-item-input.ts's normalizeItem().
//
// Neither could be covered by the existing tests/*.test.mjs tier: both
// require a real D1 to actually enforce the UNIQUE index and the
// UPDATE...WHERE race, not just the pure validation logic that tier already
// covers well.

beforeAll(async () => {
  await ensureSchema({ seed: false });
});

async function createItem(body: Record<string, unknown>) {
  const response = await itemsPost(
    new Request("http://x/api/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { response, body: (await response.json()) as { item?: Record<string, unknown>; error?: string } };
}

describe("item_links_canonical_idx (Issue #76)", () => {
  test("the index exists in the real schema, scoped to (item_id, canonical_url)", async () => {
    const index = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='item_links_canonical_idx'",
    ).first<{ sql: string }>();
    expect(index?.sql).toContain("item_links(item_id, canonical_url)");
  });

  test("rejects two links on the same item that canonicalize to the same destination", async () => {
    const { response, body } = await createItem({
      contentType: "movie",
      title: "canonical-dup-test",
      links: [
        { label: "A", url: "https://example.com/x?utm_source=a" },
        { label: "B", url: "https://example.com/x" },
      ],
    });
    expect(response.status).toBe(400);
    expect(body.error).toBe("同じリンクが重複しています。");
  });

  test("allows two different items to share the same canonical destination", async () => {
    const first = await createItem({ contentType: "movie", title: "series-ep1", links: [{ url: "https://example.com/series-archive" }] });
    const second = await createItem({ contentType: "movie", title: "series-ep2", links: [{ url: "https://example.com/series-archive" }] });
    expect(first.response.status).toBe(201);
    expect(second.response.status).toBe(201);
  });
});

describe("optimistic lock on PATCH /api/items/:id (Issue #75)", () => {
  test("a stale version is rejected with 409, and the item is left untouched", async () => {
    const { body: created } = await createItem({ contentType: "movie", title: "lock-test", links: [{ url: "https://example.com/original" }] });
    const id = created.item!.id as string;

    const staleAttempt = await itemPatch(
      new Request(`http://x/api/items/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contentType: "movie", title: "should-not-apply", version: 999 }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(staleAttempt.status).toBe(409);

    const listed = (await (await itemsGet(new Request("http://x/api/items"))).json()) as { items: Array<{ id: string; title: string }> };
    const stillOriginal = listed.items.find((item) => item.id === id);
    expect(stillOriginal?.title).toBe("lock-test");
  });

  test("the correct version succeeds and bumps the version number", async () => {
    const { body: created } = await createItem({ contentType: "movie", title: "lock-test-2" });
    const id = created.item!.id as string;
    expect(created.item!.version).toBe(1);

    const response = await itemPatch(
      new Request(`http://x/api/items/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contentType: "movie", title: "lock-test-2-updated", version: 1 }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(200);
    const updated = (await response.json()) as { item: { version: number; title: string } };
    expect(updated.item.version).toBe(2);
    expect(updated.item.title).toBe("lock-test-2-updated");
  });
});

// app/watch-list-app.tsx's save() calls app/lib/text-tube-import.ts's
// runTextTubeImport() once per id in textTubeCandidates, right after a
// successful save -- these confirm POST/PATCH compute the right set: every
// YouTube link on create, but on edit only the links that are genuinely new
// (an existing item PATCHed with unrelated field changes must not
// re-trigger an already-handled link, and a duplicate YouTube link within
// one save must not be offered twice).
describe("textTubeCandidates (Watch List -> TextTube auto-import)", () => {
  test("POST returns every distinct YouTube video id among the new item's links", async () => {
    const { response, body } = await createItem({
      contentType: "movie",
      title: "texttube-candidates-post",
      links: [
        { label: "YouTube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
        { label: "Same video, different URL form", url: "https://youtu.be/dQw4w9WgXcQ" },
        { label: "Not YouTube", url: "https://example.com/article" },
      ],
    });
    expect(response.status).toBe(201);
    const withCandidates = body as unknown as { textTubeCandidates: string[] };
    expect(withCandidates.textTubeCandidates).toEqual(["dQw4w9WgXcQ"]);
  });

  test("PATCH returns only newly added YouTube links, not ones the item already had", async () => {
    const { body: created } = await createItem({
      contentType: "movie",
      title: "texttube-candidates-patch",
      links: [{ label: "Already here", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" }],
    });
    const id = created.item!.id as string;

    // Edits only the title, keeping the same link -- nothing new to import.
    const unrelatedEdit = await itemPatch(
      new Request(`http://x/api/items/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contentType: "movie", title: "texttube-candidates-patch-renamed", links: [{ label: "Already here", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" }], version: 1 }),
      }),
      { params: Promise.resolve({ id }) },
    );
    const unrelatedBody = (await unrelatedEdit.json()) as { textTubeCandidates: string[] };
    expect(unrelatedBody.textTubeCandidates).toEqual([]);

    // Adds a second YouTube link alongside the first -- only the new one is
    // a candidate.
    const addLink = await itemPatch(
      new Request(`http://x/api/items/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contentType: "movie",
          title: "texttube-candidates-patch-renamed",
          links: [
            { label: "Already here", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" },
            { label: "New", url: "https://www.youtube.com/watch?v=bbbbbbbbbbb" },
          ],
          version: 2,
        }),
      }),
      { params: Promise.resolve({ id }) },
    );
    const addLinkBody = (await addLink.json()) as { textTubeCandidates: string[] };
    expect(addLinkBody.textTubeCandidates).toEqual(["bbbbbbbbbbb"]);
  });
});
