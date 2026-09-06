import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The general "does the page mention its own sections" and "does the nav
// have a logout link" checks that used to live here were removed (Issue
// #94): tests/workers/ssr-parity.test.ts (Issue #80 Stage 2) already
// renders these same pages for real through SELF.fetch() and asserts on
// their actual output, which is strictly stronger evidence than grepping
// the source for a brand string. Keeping both was redundant, not
// complementary.

// The To Do recurring-task and Manage Asset snapshot-grouping checks that
// used to be here were removed (Issue #94) and replaced with real-behavior
// coverage against a real D1: tests/workers/todo-routines.test.ts (actually
// creates a routine and confirms it materializes, and does not on an
// unscheduled day) and tests/workers/manage-asset-sync.test.ts (actually
// syncs two sources and confirms /history does not cross-attribute their
// positions -- verified to catch the regression by temporarily reintroducing
// the old composite-key grouping bug and confirming the test failed).

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

// The portal-JPY-fallback and CF-Access-logout-link checks that used to be
// here were removed (Issue #94): the former was already redundant with
// tests/portal-summary.test.mjs's behavioral coverage of the same fallback
// (its own comment said as much), and the latter was a single-line
// presence check with no behavior to verify.

// The YouTube-scraping and Supadata-transcript checks that used to be here
// were removed (Issue #94) and replaced with real-behavior coverage:
// tests/workers/watch-list-youtube-preview.test.ts and
// tests/workers/text-tube-youtube-preview.test.ts actually call each route
// with the outbound fetch mocked (see
// tests/workers/fixtures/outbound-mocks.ts, and that file's own comment for
// how outbound mocking under @cloudflare/vitest-pool-workers was discovered
// and verified) rather than grepping the route's source for the endpoint
// URL and field names -- verified to catch a real regression by temporarily
// breaking the og:title extraction and confirming the test failed.

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
