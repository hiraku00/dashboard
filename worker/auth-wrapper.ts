import app from "../dist/server/index.js";

// wrangler.jsonc's `main` points here, not at worker/index.ts. worker/index.ts
// is the SOURCE that vite/vinext bundles (it imports the virtual module
// "virtual:vinext-rsc-entry", resolved only by the vinext vite plugin during
// `npm run build` / `vinext dev`); `wrangler deploy` runs its own esbuild pass
// over whatever `main` names and cannot resolve that virtual import. This file
// exists to give wrangler something it CAN bundle: the already-built
// dist/server/index.js, thinly wrapped.
const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const response = await app.fetch(request, env, ctx);
    if (!request.headers.get("accept")?.includes("text/html")) return response;
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store, max-age=0, must-revalidate");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  // Without this re-export the daily cron trigger ("17 2 * * *" in
  // wrangler.jsonc) fires into a Worker that has no scheduled handler at all:
  // dist/server/index.js's default export does have one (it runs the R2
  // reconciliation into storage_usage_daily), but this wrapper is what
  // actually ships, and it used to only forward fetch.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    await app.scheduled(controller, env, ctx);
  },
};

export default worker;
