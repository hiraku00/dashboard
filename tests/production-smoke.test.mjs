import assert from "node:assert/strict";

// What this can and cannot check.
//
// Every route is behind Cloudflare Access, and CI has no Access credentials,
// so nothing here can see the app's own output -- a completely broken Worker
// would answer these requests exactly the same way, because Access replies
// before the Worker runs. This used to assert only `status < 400`, which the
// Access redirect satisfies, so the check passed no matter what was deployed.
//
// What it can check is the thing that actually went wrong in production: that
// every route is still behind Access. A version preview URL once served the
// whole app, including the portfolio API, with no Access check at all, because
// Access is bound to one hostname and the preview URL is a different one. So
// this asserts the guard is present rather than pretending to health-check.

const baseUrl = (process.env.SMOKE_BASE_URL ?? "https://dashboard.hiraku00.workers.dev").replace(/\/$/, "");
const paths = [
  "/",
  "/watch-list",
  "/text-tube",
  "/manage-asset",
  "/todo",
  // Static assets are served without invoking the Worker unless
  // assets.run_worker_first is set, so they are their own case.
  "/manage-asset-original/index.html",
  // The endpoints worth being loudest about: they read and write the data.
  "/api/manage-asset/state",
  "/api/manage-asset/history",
  "/api/items",
];

const failures = [];

for (const path of paths) {
  const url = `${baseUrl}${path}`;
  let response;
  try {
    response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    failures.push(`${path}: request failed (${error.message})`);
    continue;
  }

  const location = response.headers.get("location") ?? "";
  const challenge = response.headers.get("www-authenticate") ?? "";
  const guarded =
    challenge.toLowerCase().includes("cloudflare-access") || location.includes("cloudflareaccess.com");

  if (!guarded) {
    // Anything that answers without an Access challenge is serving this app to
    // an unauthenticated caller.
    failures.push(`${path}: reachable without Cloudflare Access (HTTP ${response.status})`);
    continue;
  }
  assert.ok(response.status < 500, `${path} returned HTTP ${response.status}`);
}

if (failures.length) {
  console.error("Production smoke test FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Production smoke test passed: ${paths.length} routes all behind Cloudflare Access at ${baseUrl}`);
console.log("Note: this cannot verify app health -- Access answers before the Worker runs.");
