import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
test("defines the dashboard and its primary functions", async () => {
  const [page, app, layout, portal] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/watch-list-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/portal-home.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /PortalHome/);
  assert.match(portal, /Dashboard/);
  assert.match(portal, /TextTube/);
  assert.match(portal, /Manage Asset/);
  assert.match(portal, /To Do/);
  assert.match(app, /Watch List/);
  assert.match(app, /target="_blank"/);
  assert.match(app, /dateLabel/);
  assert.match(app, /api\/items/);
  assert.match(app, /portal-nav/);
  assert.match(layout, /Dashboard/);
});

test("ships the To Do board, recurring-task API, and portal navigation", async () => {
  const [app, board, routines, nav, migration] = await Promise.all([
    readFile(new URL("../app/todo-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/todos/board/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/todos/routines/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/portal-nav.tsx", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0003_todo.sql", import.meta.url), "utf8"),
  ]);
  assert.match(app, /繰り返しタスク/);
  assert.match(app, /api\/todos\/tasks/);
  assert.match(board, /materializeRoutines/);
  assert.match(routines, /schedule_type/);
  assert.match(nav, /"\/todo", "To Do"/);
  assert.match(migration, /UNIQUE\(routine_id, occurrence_date\)/);
});

test("keeps Manage Asset positions attached to one D1 snapshot", async () => {
  const route = await readFile(
    new URL("../app/api/manage-asset/history/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /s\.id AS snapshot_id/);
  assert.match(route, /String\(position\.snapshot_id \?\? ""\)/);
  assert.match(route, /String\(row\.id \?\? ""\)/);
  assert.doesNotMatch(
    route,
    /const key = `\$\{position\.source_id\}\|\$\{position\.as_of_date\}\|\$\{position\.captured_at\}`/,
  );
});

test("keeps normalized exchange quantities in the original Manage Asset client", async () => {
  const core = await readFile(
    new URL(
      "../public/manage-asset-original/portfolio-core.js",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    core,
    /position\.net_quantity\?\?position\.quantity\?\?position\.amount/,
  );
  assert.match(
    core,
    /position\.usd_value\?\?position\.value_usd\?\?position\.usdValue/,
  );
});

test("labels non-stETH balance deltas as changes rather than rewards", async () => {
  const compatibility = await readFile(
    new URL("../public/manage-asset-original/compat-fixes.js", import.meta.url),
    "utf8",
  );
  assert.match(compatibility, /select\.value\.toLowerCase\(\) === 'steth'/);
  assert.match(compatibility, /nodeValue === 'Reward'/);
});

test("derives portal JPY totals when synced snapshot totals are absent", async () => {
  const route = await readFile(
    new URL("../app/api/portal/summary/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /asset_positions/);
  assert.match(route, /storedJpy \|\| positionTotals\?\.jpy/);
});

test("uses Cloudflare Access native logout", async () => {
  const nav = await readFile(
    new URL("../app/portal-nav.tsx", import.meta.url),
    "utf8",
  );
  assert.match(nav, /href="\/cdn-cgi\/access\/logout"/);
});

test("imports public YouTube page metadata into the Watch List editor", async () => {
  const [app, route] = await Promise.all([
    readFile(new URL("../app/watch-list-app.tsx", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../app/api/watch-list/youtube-preview/route.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  assert.match(app, /YouTubeから入力/);
  assert.match(app, /api\/watch-list\/youtube-preview/);
  assert.match(route, /www\.youtube\.com\/watch/);
  assert.match(route, /og:title/);
  assert.match(route, /ownerChannelName/);
  assert.match(route, /label: "YouTube"/);
  assert.doesNotMatch(route, /googleapis\.com|oembed/);
});

test("imports TextTube captions through the managed transcript API and records actual usage", async () => {
  const [route, usageRoute, usagePage] = await Promise.all([
    readFile(
      new URL("../app/api/text-tube/youtube-preview/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/api/settings/storage/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/settings/storage/page.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(route, /api\.supadata\.ai\/v1\/transcript/);
  assert.match(route, /mode: "native"/);
  assert.match(route, /x-billable-requests/);
  assert.match(route, /text_tube_api_usage/);
  assert.match(usageRoute, /text_tube_api_usage/);
  assert.match(usagePage, /Supadataで確認/);
  assert.match(usagePage, /dash\.supadata\.ai/);
});

test("closes the TextTube editor when its backdrop is clicked", async () => {
  const app = await readFile(
    new URL("../app/text-tube-app.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    app,
    /className="tt-modal-backdrop" role="presentation" onClick=\{onClose\}/,
  );
  assert.match(app, /onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(app, /aria-modal="true"/);
});
