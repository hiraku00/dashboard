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
    { cwd: new URL("..", import.meta.url), stdio: "pipe" },
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
  if (!server || server.killed) return;
  server.kill("SIGTERM");
  // Give wrangler's child processes (workerd) a moment to exit cleanly before
  // the test process itself exits, or CI can leave orphaned listeners behind.
  await delay(500);
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
