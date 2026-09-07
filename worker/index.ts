/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { reconcileStorageUsage } from "../app/lib/storage-usage";
import { guardRequest } from "../app/lib/access";
import { initTodo, materializeRoutines, todoDate } from "../app/api/todos/_lib";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  FILES: R2Bucket;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Cloudflare Access is configured per hostname, so a hostname it does not
    // cover reaches this Worker unchecked. Re-verify its assertion here, ahead
    // of everything else including static assets and the image optimizer, so
    // the app is not relying on the edge alone. No-op until ACCESS_TEAM_DOMAIN
    // and ACCESS_AUD are set.
    const denied = await guardRequest(request, env as unknown as Record<string, unknown>);
    if (denied) return denied;

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    void _ctx;
    if (!env.DB) return;
    // wrangler.jsonc's `triggers.crons` has two independent schedules
    // firing this same handler; `controller.cron` says which one woke it.
    // "0 17 * * *" = UTC 17:00 = Asia/Bangkok 00:00 (todoDate()'s timezone),
    // i.e. right after the To Do board's day rolls over -- see Issue #71 for
    // why this materialization was moved out of GET /api/todos/board.
    if (controller.cron === "0 17 * * *") {
      await initTodo();
      await materializeRoutines(todoDate());
      return;
    }
    if (!env.FILES) return;
    await reconcileStorageUsage(env.FILES, env.DB, "scheduled-r2-list");
  },
};

export default worker;
