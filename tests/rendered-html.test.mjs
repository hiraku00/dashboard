import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
test("defines the dashboard and its primary functions", async () => { const [page, app, layout, portal] = await Promise.all([readFile(new URL("../app/page.tsx", import.meta.url), "utf8"), readFile(new URL("../app/watch-list-app.tsx", import.meta.url), "utf8"), readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"), readFile(new URL("../app/portal-home.tsx", import.meta.url), "utf8")]); assert.match(page, /PortalHome/); assert.match(portal, /Dashboard/); assert.match(portal, /TextTube/); assert.match(portal, /Manage Asset/); assert.match(app, /Watch List/); assert.match(app, /target="_blank"/); assert.match(app, /dateLabel/); assert.match(app, /api\/items/); assert.match(app, /portal-nav/); assert.match(layout, /Dashboard/); });

test("keeps Manage Asset positions attached to one D1 snapshot", async () => {
  const route = await readFile(new URL("../app/api/manage-asset/history/route.ts", import.meta.url), "utf8");
  assert.match(route, /s\.id AS snapshot_id/);
  assert.match(route, /String\(position\.snapshot_id \?\? ""\)/);
  assert.match(route, /String\(row\.id \?\? ""\)/);
  assert.doesNotMatch(route, /const key = `\$\{position\.source_id\}\|\$\{position\.as_of_date\}\|\$\{position\.captured_at\}`/);
});

test("keeps normalized exchange quantities in the original Manage Asset client", async () => {
  const core = await readFile(new URL("../public/manage-asset-original/portfolio-core.js", import.meta.url), "utf8");
  assert.match(core, /position\.net_quantity\?\?position\.quantity\?\?position\.amount/);
  assert.match(core, /position\.usd_value\?\?position\.value_usd\?\?position\.usdValue/);
});

test("labels non-stETH balance deltas as changes rather than rewards", async () => {
  const compatibility = await readFile(new URL("../public/manage-asset-original/compat-fixes.js", import.meta.url), "utf8");
  assert.match(compatibility, /select\.value\.toLowerCase\(\) === 'steth'/);
  assert.match(compatibility, /nodeValue === 'Reward'/);
});

test("derives portal JPY totals when synced snapshot totals are absent", async () => {
  const route = await readFile(new URL("../app/api/portal/summary/route.ts", import.meta.url), "utf8");
  assert.match(route, /asset_positions/);
  assert.match(route, /storedJpy \|\| positionTotals\?\.jpy/);
});

test("uses Cloudflare Access native logout", async () => {
  const nav = await readFile(new URL("../app/portal-nav.tsx", import.meta.url), "utf8");
  assert.match(nav, /href="\/cdn-cgi\/access\/logout"/);
});
