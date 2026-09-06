import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Two tiers of tests run through this one config:
//
// - tests/workers/**/*.test.ts: imports real app code (route handlers,
//   ensureSchema()) that reaches `cloudflare:workers` bindings. Runs inside
//   an actual workerd instance via @cloudflare/vitest-pool-workers, with a
//   real (ephemeral, per-run) D1 and R2 -- not mocks. This is the tier that
//   replaces the wrangler-dev-as-a-child-process approach in
//   tests/ssr-parity.test.mjs (see that file's own comment for why that
//   approach hangs GitHub Actions' Ubuntu runners): the pool manages
//   workerd's lifecycle itself, so there is no spawned process, no stdio
//   pipe, and nothing left running after the run exits.
//
// - tests/**/*.test.mjs: the existing plain-Node tests (unchanged, still
//   run by `node --test` per package.json's "test" script during this
//   migration's Stage 1). Nothing here touches them; they coexist with the
//   new tier until a later stage moves them over too.
//
// `wrangler.configPath` makes the pool build and load the real worker
// (dist/server/index.js via worker/auth-wrapper.ts) so tests can exercise
// either the fast tier (import a route handler directly -- no build
// required) or SELF.fetch() against the actual built app (requires
// `npm run build` first, same as tests/ssr-parity.test.mjs already does).
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    include: ["tests/workers/**/*.test.ts"],
  },
});
