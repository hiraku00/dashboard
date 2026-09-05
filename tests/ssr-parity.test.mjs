import assert from "node:assert/strict";
import { test, after, before } from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// SSR統合ハーネス（F-1: RSC化のための土台）。
//
// tests/rendered-html.test.mjs はソースを readFile して正規表現でマッチさせて
// いるだけで、実際にページがレンダリングされるかは一切見ていない。これは
// 「500を返すページ」を検出できない --- PR #45で本番のCSS/JSが全滅した時も
// このテストは緑のままだった。
//
// ここでは実際に `wrangler dev --local`（本番と同じアセットバインディング。
// `npm run dev` の vite単体サーブでは検証にならない --- 過去にその取り違えで
// 本番を壊した）を起動し、本物のHTTPリクエストでページとAPIの両方を叩く。
//
// CIには含めていない (npm run test:ssr で手動実行する): GitHub Actions の
// Ubuntu runner でこれを npm test に含めたところ、Lint/Typecheckは通った後
// このテストのステップだけ15分以上ハングした。ローカル(macOS)では問題なく
// 動いていたため、Linux特有かCI環境特有の問題と推測している --- wrangler
// dev が起動する workerd 子プロセスがSIGTERMで終了せず、標準入出力の
// パイプが閉じないままジョブ全体が終了待ちになる、というのはWrangler/
// workerdでたびたび報告される既知の症状に近い。原因を実機のCIランナーで
// 切り分けられていない状態で全PRのCIを塞ぐ必須ステップに残すのは危険が
// 大きいと判断し、必須テストからは外した。後続でCI環境での原因が特定でき
// 次第、必須テストに戻す。
//
// 現時点（RSC化前）でのこのテストの役割は「ページ/APIが実際に200を返し、
// 期待する形のJSONを返すこと」の基準線を作ることだけ。ページのHTMLに
// データが埋め込まれているというアサーションは、各ページをRSC化するPRで
// 追加する --- そうすることで「変換前は無く、変換後にだけ通る」形になり、
// 効果がテスト自体で証明される。

const PORT = 18787 + (Number(process.env.TEST_WORKER_ID ?? 0) % 100);
const BASE = `http://localhost:${PORT}`;
const STARTUP_TIMEOUT_MS = 60_000;

let server;

async function waitForServer() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2_000) });
      if (response.status) return;
    } catch {
      // Not up yet.
    }
    await delay(500);
  }
  throw new Error(`wrangler dev did not become ready on ${BASE} within ${STARTUP_TIMEOUT_MS}ms`);
}

before(async () => {
  server = spawn(
    "npx",
    ["wrangler", "dev", "--config", "wrangler.jsonc", "--port", String(PORT), "--local"],
    {
      cwd: new URL("..", import.meta.url),
      stdio: "pipe",
      // Its own process group so after() can kill wrangler's workerd child
      // along with it (`kill(-pid)` targets the whole group), not just the
      // immediate npx process -- a bare server.kill() can leave workerd
      // running with this test's stdio pipes still open.
      detached: true,
      env: {
        ...process.env,
        // Skip wrangler's first-run interactive telemetry consent prompt.
        // stdio is piped (not inherited), so if that prompt ever did appear
        // here it would block forever waiting for input nothing will send.
        WRANGLER_SEND_METRICS: "false",
      },
    },
  );
  let output = "";
  server.stdout?.on("data", (chunk) => { output += chunk; });
  server.stderr?.on("data", (chunk) => { output += chunk; });
  server.on("error", (error) => { throw error; });
  try {
    await waitForServer();
  } catch (error) {
    console.error("--- wrangler dev output ---\n" + output);
    throw error;
  }
});

after(async () => {
  if (!server || server.killed || !server.pid) return;
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    // Group already gone.
  }
  await delay(1_000);
  try {
    process.kill(-server.pid, "SIGKILL");
  } catch {
    // Already exited after SIGTERM -- this is the expected outcome.
  }
});

test("GET / renders the portal shell without erroring", async () => {
  const response = await fetch(`${BASE}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /portal-nav/);
  assert.match(html, /Watch List/);
});

test("GET /watch-list renders without erroring", async () => {
  const response = await fetch(`${BASE}/watch-list`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /portal-nav/);
  assert.match(html, /app-shell/);
});

test("GET /api/items returns the shape the Watch List page consumes", async () => {
  const response = await fetch(`${BASE}/api/items?limit=1`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.items));
  assert.ok(typeof body.pagination.total === "number");
  assert.ok(typeof body.pagination.hasMore === "boolean");
});

test("GET /api/stats returns the shape the Watch List page consumes", async () => {
  const response = await fetch(`${BASE}/api/stats`);
  assert.equal(response.status, 200);
  const body = await response.json();
  for (const key of ["total", "completed", "movie", "audio", "text"]) {
    assert.ok(typeof body[key] === "number", `expected ${key} to be a number`);
  }
});

test("GET /api/portal/summary returns the shape PortalHome consumes", async () => {
  const response = await fetch(`${BASE}/api/portal/summary`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(typeof body.watch.total === "number");
  assert.ok(typeof body.textTube.total === "number");
  assert.ok(typeof body.assets.totalUsd === "number");
  assert.ok(typeof body.todo.total === "number");
});

test("an unknown route still 404s through the Worker rather than hanging", async () => {
  const response = await fetch(`${BASE}/this-route-does-not-exist`);
  assert.equal(response.status, 404);
});

// app/page.tsx is now a Server Component that fetches the portal summary
// directly from D1 (app/lib/queries/portal.ts) instead of shipping an empty
// shell and letting the client fetch /api/portal/summary after hydration.
// This is the assertion the PR1 harness comment promised: unlike the tests
// above (which only prove the route responds), this proves the effect the
// whole migration exists for -- the number is already in the HTML that came
// back from the server, not something a client-side fetch had to fill in
// afterward. Comparing against the live /api/portal/summary value (rather
// than a hardcoded number) keeps this passing as the seeded data changes.
test("GET / embeds the real Watch List total in the server-rendered HTML", async () => {
  const [pageResponse, summary] = await Promise.all([
    fetch(`${BASE}/`),
    fetch(`${BASE}/api/portal/summary`).then((response) => response.json()),
  ]);
  const html = await pageResponse.text();
  // React renders a text-node boundary comment between static text and a
  // dynamic value (e.g. `>807<!-- -->件<`), so this checks for the number
  // immediately following the Watch List card's opening tag rather than an
  // exact adjacent string match.
  const watchCard = html.match(/portal-card-watch"[^>]*>.*?<strong>(\d+)/s);
  assert.ok(watchCard, "expected a portal-card-watch section with a numeric total in the raw HTML");
  assert.equal(Number(watchCard[1]), summary.watch.total);
});

test("GET / does not ask the client to fetch what the server already rendered", async () => {
  const html = await fetch(`${BASE}/`).then((response) => response.text());
  // "読み込み中" (loading) is what every card shows before the client-side
  // fetch resolves; the pre-RSC page always shipped this in its initial HTML
  // because it fetched nothing on the server. Its absence here is direct
  // evidence the client hydrates into already-complete data instead of a
  // loading state, not just that portalSummary() happens to have been called
  // somewhere.
  assert.doesNotMatch(html, /読み込み中/);
});
