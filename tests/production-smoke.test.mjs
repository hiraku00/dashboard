import assert from "node:assert/strict";

const baseUrl = (process.env.SMOKE_BASE_URL ?? "https://dashboard.hiraku00.workers.dev").replace(/\/$/, "");
const paths = ["/", "/watch-list", "/text-tube", "/manage-asset", "/todo"];

for (const path of paths) {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  assert.ok(response.status >= 200 && response.status < 400, `${path} returned HTTP ${response.status}`);
}

console.log(`Production smoke test passed for ${paths.length} routes at ${baseUrl}`);
