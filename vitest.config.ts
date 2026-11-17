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
// - "dom" (tests/dom/**/*.test.{ts,tsx}): app/text-tube/video-edit-app.tsx's add / edit page
//   (a real React component's click behavior, tested with
//   @testing-library/react), which genuinely needs a DOM. Originally also
//   covered public/manage-asset-original/compat-fixes.js, removed once the
//   Manage Asset iframe app it patched was replaced by a native RSC
//   implementation.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              // Test-only keys so app/api/text-tube/youtube-preview's own
              // `if (!key) return ...not configured...` guard don't short-circuit before
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
          // tests/*.test.mjs を全部拾う。以前は1本ずつ手で並べていたので、新しいテストを足して
          // この一覧に入れ忘れると、黙って実行されず、消したテストの名前は残り続けた。
          // production-smoke.test.mjs は本番を叩く確認で、`npm run smoke:production` から単独で動かす。
          include: ["tests/*.test.mjs"],
          exclude: ["tests/production-smoke.test.mjs"],
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
