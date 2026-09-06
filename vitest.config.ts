import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { mockOutboundResponse } from "./tests/workers/fixtures/outbound-mocks";

// Three projects run under this one `vitest run` invocation (Issue #80,
// Issue #94):
//
// - "workers" (tests/workers/**/*.test.ts): imports real app code (route
//   handlers, ensureSchema()) that reaches `cloudflare:workers` bindings.
//   Runs inside an actual workerd instance via
//   @cloudflare/vitest-pool-workers, with a real (ephemeral, per-run) D1 and
//   R2 -- not mocks. Introduced in Stage 1 to replace the
//   wrangler-dev-as-a-child-process approach that hung GitHub Actions'
//   Ubuntu runners (see this project's git history for
//   tests/ssr-parity.test.mjs, migrated in Stage 2 to
//   tests/workers/ssr-parity.test.ts).
//
// - "node" (tests/*.test.mjs): pure-logic tests for app/lib/*.ts modules
//   that do not import "cloudflare:workers" at all -- no D1, no R2, no
//   workerd needed. These ran under plain `node --test` before Stage 3
//   (this project's git history has the node:assert-based originals); they
//   were moved onto vitest here purely to consolidate on one test runner
//   (Issue #80's eventual goal), not because they needed anything workerd
//   provides. Deliberately a *separate* project from "workers", with a
//   plain "node" environment: running these through workerd would work but
//   would slow them down for no benefit, since none of them touch a
//   binding.
//
// - "dom" (tests/dom/**/*.test.{ts,tsx}): the two remaining pieces of
//   tests/rendered-html.test.mjs (Issue #94) that genuinely need a DOM --
//   public/manage-asset-original/compat-fixes.js (reads `document`, uses
//   MutationObserver) and app/text-tube-app.tsx's VideoEditor (a real React
//   component's click behavior, tested with @testing-library/react). Every
//   other rendered-html.test.mjs check either had a stronger equivalent
//   already elsewhere or turned out not to need a DOM at all once looked at
//   closely (see tests/portfolio-core.test.mjs's own comment).
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              // Test-only keys so app/api/watch-list/youtube-preview and
              // app/api/text-tube/youtube-preview's own `if (!key) return
              // ...not configured...` guards don't short-circuit before
              // reaching the outboundService mock below. Not real secrets --
              // this project has no .dev.vars checked in and these routes
              // never see real credentials outside of production.
              bindings: {
                YOUTUBE_DATA_API_KEY: "test-only-fake-key",
                SUPADATA_API_KEY: "test-only-fake-key",
              },
              // Not documented by @cloudflare/vitest-pool-workers itself, but
              // it is Miniflare's own WorkerOptions field and is honored --
              // see tests/workers/fixtures/outbound-mocks.ts for what it
              // returns and why per-test dynamic responses are not available
              // under it.
              outboundService: mockOutboundResponse,
            },
          }),
        ],
        resolve: {
          alias: {
            "@": fileURLToPath(new URL(".", import.meta.url)),
          },
        },
        test: {
          name: "workers",
          include: ["tests/workers/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "node",
          environment: "node",
          include: [
            "tests/access.test.mjs",
            "tests/history-window.test.mjs",
            "tests/manage-asset-core.test.mjs",
            "tests/portal-summary.test.mjs",
            "tests/portfolio-core.test.mjs",
            "tests/schema-parity.test.mjs",
            "tests/shared-helpers.test.mjs",
            "tests/sync-summary.test.mjs",
            "tests/text-tube-query.test.mjs",
            "tests/text-tube-video-input.test.mjs",
            "tests/todo-task-input.test.mjs",
            "tests/usage-window.test.mjs",
            "tests/watch-list-item-input.test.mjs",
            "tests/watch-list-query.test.mjs",
          ],
        },
      },
      {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL(".", import.meta.url)),
          },
        },
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["tests/dom/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
