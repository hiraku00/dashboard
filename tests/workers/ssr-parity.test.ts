import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { ensureSchema } from "@/db";

// Replaces tests/ssr-parity.test.mjs (Issue #80, Stage 2). That file spawned
// `wrangler dev --local` as a child process and hit it with real HTTP
// requests -- necessary at the time because nothing else could give a test
// the production asset/binding wiring, but its own comment records that this
// hangs GitHub Actions' Ubuntu runners for 15+ minutes (workerd's child
// process not dying cleanly to SIGTERM, stdio pipes staying open), so it was
// pulled from the required `npm test` and left as a manual-only
// `npm run test:ssr`.
//
// @cloudflare/vitest-pool-workers (introduced in Stage 1,
// tests/workers/items-route.test.ts) runs the built worker
// (dist/server/index.js, same as `wrangler dev` would) inside an in-process
// workerd instance via SELF.fetch() -- no spawned process, no stdio pipe, so
// that hang has nothing to hang on. Verified in Stage 1's PR: the CI run on
// Ubuntu completed in ~1.5s with zero leftover processes.
//
// One real behavior difference from the old harness: that harness's
// TextTube assertions depended on whatever had accumulated in the
// developer's own local D1 from prior manual testing ("this assertion is
// meaningless against an empty D1 -- seed at least one video before running
// this suite" -- a comment, not an enforced precondition). Each vitest run
// gets a fresh, empty D1, so this version seeds what it needs itself in
// beforeAll, through the same public API a user would.

const BASE = "http://ssr-parity-test.example";

beforeAll(async () => {
  await ensureSchema({ seed: false });
});

async function seedOneItem() {
  const response = await SELF.fetch(`${BASE}/api/items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contentType: "movie", title: "ssr-parity-seed-item" }),
  });
  expect(response.status).toBe(201);
}

async function seedOneVideo() {
  const response = await SELF.fetch(`${BASE}/api/text-tube/videos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "ssr-parity-seed-video", summary: "seed summary" }),
  });
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  return id;
}

describe("portal shell", () => {
  test("GET / renders the portal shell without erroring", async () => {
    const response = await SELF.fetch(`${BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/portal-nav/);
    expect(html).toMatch(/Watch List/);
  });

  // app/page.tsx is a Server Component that fetches the portal summary
  // directly from D1 (app/lib/queries/portal.ts) instead of shipping an
  // empty shell and letting the client fetch /api/portal/summary after
  // hydration. Comparing against the live /api/portal/summary value (rather
  // than a hardcoded number) keeps this passing as seeded data changes.
  test("GET / embeds the real Watch List total in the server-rendered HTML", async () => {
    await seedOneItem();
    const [pageResponse, summary] = await Promise.all([
      SELF.fetch(`${BASE}/`),
      SELF.fetch(`${BASE}/api/portal/summary`).then((response) => response.json() as Promise<{ watch: { total: number } }>),
    ]);
    const html = await pageResponse.text();
    // React renders a text-node boundary comment between static text and a
    // dynamic value (e.g. `>807<!-- -->件<`), so this checks for the number
    // immediately following the Watch List card's opening tag rather than an
    // exact adjacent string match.
    // [\s\S]*? instead of a dotAll (/s) .*? -- tsconfig.json's target
    // (ES2017) predates the dotAll flag, and bumping it is a project-wide
    // change out of scope here; this achieves the same "match across
    // newlines" behavior without it.
    const watchCard = html.match(/portal-card-watch"[^>]*>[\s\S]*?<strong>(\d+)/);
    expect(watchCard, "expected a portal-card-watch section with a numeric total in the raw HTML").toBeTruthy();
    expect(Number(watchCard![1])).toBe(summary.watch.total);
  });

  test("GET / does not ask the client to fetch what the server already rendered", async () => {
    const html = await SELF.fetch(`${BASE}/`).then((response) => response.text());
    // "読み込み中" (loading) is what every card shows before the client-side
    // fetch resolves; the pre-RSC page always shipped this in its initial
    // HTML because it fetched nothing on the server. Its absence here is
    // direct evidence the client hydrates into already-complete data instead
    // of a loading state.
    expect(html).not.toMatch(/読み込み中/);
  });
});

describe("Watch List page", () => {
  test("GET /watch-list renders without erroring", async () => {
    const response = await SELF.fetch(`${BASE}/watch-list`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/portal-nav/);
    expect(html).toMatch(/app-shell/);
  });

  test("GET /watch-list embeds the real item count and first page of rows in the server-rendered HTML", async () => {
    await seedOneItem();
    const [pageResponse, itemsPage, stats] = await Promise.all([
      SELF.fetch(`${BASE}/watch-list`),
      SELF.fetch(`${BASE}/api/items?limit=10&offset=0`).then((response) => response.json() as Promise<{ items: unknown[] }>),
      SELF.fetch(`${BASE}/api/stats`).then((response) => response.json() as Promise<{ total: number }>),
    ]);
    const html = await pageResponse.text();
    const rowCount = (html.match(/<tr class="/g) ?? []).length;
    expect(rowCount, "expected the server-rendered table to already have the first page of rows").toBe(itemsPage.items.length);
    const summaryTotal = html.match(/summary-card"><span>すべて<\/span><strong>(\d+)/);
    expect(summaryTotal, "expected the 'すべて' summary card to have a numeric total in the raw HTML").toBeTruthy();
    expect(Number(summaryTotal![1])).toBe(stats.total);
  });

  test("GET /watch-list does not ask the client to fetch what the server already rendered", async () => {
    const html = await SELF.fetch(`${BASE}/watch-list`).then((response) => response.text());
    expect(html).not.toMatch(/読み込み中/);
  });
});

describe("TextTube pages", () => {
  // app/text-tube/page.tsx and app/text-tube/studio/page.tsx are Server
  // Components (see app/lib/queries/text-tube.ts). Both share the same
  // underlying video list, so both get the same assertion. Neither page
  // ever showed a "読み込み中" placeholder even before RSC -- an empty
  // grid/table just rendered with zero rows -- so the meaningful check here
  // is that the rendered markup actually links every video, not the absence
  // of loading text.
  for (const path of ["/text-tube", "/text-tube/studio"]) {
    test(`GET ${path} embeds the real video list in the server-rendered HTML`, async () => {
      await seedOneVideo();
      const [pageResponse, videosPage] = await Promise.all([
        SELF.fetch(`${BASE}${path}`),
        SELF.fetch(`${BASE}/api/text-tube/videos`).then((response) => response.json() as Promise<{ videos: unknown[] }>),
      ]);
      const html = await pageResponse.text();
      // Both pages render one Link/row per video with the video's own id in
      // the href, so counting distinct /text-tube/watch/<id> hrefs counts
      // rendered videos regardless of which markup (grid card vs. table
      // row) the page uses.
      const linkedIds = new Set([...html.matchAll(/\/text-tube\/watch\/([^"?]+)/g)].map((match) => match[1]));
      expect(linkedIds.size).toBe(videosPage.videos.length);
      expect(videosPage.videos.length).toBeGreaterThan(0);
    });
  }

  // app/text-tube/watch/[id]/page.tsx fetches both the video (D1) and its
  // document (R2) directly at render time -- see getVideoDetail() in
  // app/lib/queries/text-tube.ts.
  test("GET /text-tube/watch/<id> embeds the video's title and summary in the server-rendered HTML", async () => {
    const id = await seedOneVideo();
    const html = await SELF.fetch(`${BASE}/text-tube/watch/${id}`).then((response) => response.text());
    expect(html).toContain("ssr-parity-seed-video");
    expect(html).not.toMatch(/読み込み中/);
  });

  test("GET /text-tube/watch/<id> renders a real not-found page for an id that does not exist, without a client-side retry loop", async () => {
    const response = await SELF.fetch(`${BASE}/text-tube/watch/this-id-does-not-exist`);
    expect(response.status, "a missing video is a normal page, not a 404 HTTP status, in this app's design").toBe(200);
    const html = await response.text();
    expect(html).toMatch(/動画が見つかりません/);
  });
});

describe("To Do page", () => {
  // app/todo/page.tsx is a Server Component (Issue #71) that fetches
  // today's board directly from D1 -- see app/lib/queries/todo.ts. This was
  // deliberately excluded from F-1's original RSC pass because GET
  // /api/todos/board used to write to D1 (materializeRoutines()) on every
  // read; Issue #71 moved that write out to the daily cron and to
  // insurance calls in the write endpoints (see those routes' own
  // comments) before this page could be converted safely.
  async function createDailyRoutine(title: string) {
    const response = await SELF.fetch(`${BASE}/api/todos/routines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, scheduleType: "daily", defaultColumnId: "todo-today" }),
    });
    expect(response.status).toBe(201);
  }

  test("GET /todo renders without erroring", async () => {
    const response = await SELF.fetch(`${BASE}/todo`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/portal-nav/);
    expect(html).toMatch(/todo-shell/);
  });

  // Creating the routine (rather than relying on this GET) is what
  // materializes today's task -- see app/api/todos/routines/route.ts's
  // POST. A real regression here would be either this page not showing it
  // (RSC layer stale) or the create endpoint failing to self-heal at all.
  test("GET /todo embeds a routine materialized via the create-insurance path in the server-rendered HTML", async () => {
    await createDailyRoutine("ssr-parity-todo-routine");
    const html = await SELF.fetch(`${BASE}/todo`).then((response) => response.text());
    expect(html).toContain("ssr-parity-todo-routine");
  });

  test("GET /todo does not ask the client to fetch what the server already rendered", async () => {
    const html = await SELF.fetch(`${BASE}/todo`).then((response) => response.text());
    // "todo-skeleton" is what each column shows before the client-side
    // fetch resolves (see app/todo-app.tsx); its absence here is direct
    // evidence the client hydrates into already-complete data instead of a
    // loading state.
    expect(html).not.toMatch(/todo-skeleton/);
  });
});

describe("API response shapes", () => {
  test("GET /api/items returns the shape the Watch List page consumes", async () => {
    const response = await SELF.fetch(`${BASE}/api/items?limit=1`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; pagination: { total: number; hasMore: boolean } };
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.pagination.total).toBe("number");
    expect(typeof body.pagination.hasMore).toBe("boolean");
  });

  test("GET /api/stats returns the shape the Watch List page consumes", async () => {
    const response = await SELF.fetch(`${BASE}/api/stats`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    for (const key of ["total", "completed", "movie", "audio", "text"]) {
      expect(typeof body[key], `expected ${key} to be a number`).toBe("number");
    }
  });

  test("GET /api/portal/summary returns the shape PortalHome consumes", async () => {
    const response = await SELF.fetch(`${BASE}/api/portal/summary`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { watch: { total: number }; textTube: { total: number }; assets: { totalUsd: number }; todo: { total: number } };
    expect(typeof body.watch.total).toBe("number");
    expect(typeof body.textTube.total).toBe("number");
    expect(typeof body.assets.totalUsd).toBe("number");
    expect(typeof body.todo.total).toBe("number");
  });

  test("an unknown route still 404s through the Worker rather than hanging", async () => {
    const response = await SELF.fetch(`${BASE}/this-route-does-not-exist`);
    expect(response.status).toBe(404);
  });
});
