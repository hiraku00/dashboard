/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { reconcileStorageUsage } from "../app/lib/storage-usage";
import { measureD1Tables } from "../app/lib/d1-table-usage";
import { ensureSchema } from "../db";
import { guardRequest } from "../app/lib/access";
import { initTodo, materializeRoutines, todoDate } from "../app/lib/todo-lib";

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
    void controller;
    // wrangler.jsonc has a single schedule, "0 17 * * *" = UTC 17:00 = Asia/Bangkok 00:00
    // (todoDate()'s timezone), i.e. right after the app's day rolls over. Every daily job
    // runs here, each guarded on its own so one failing does not skip the others.
    //
    // 1. To Do: materialize today's recurring tasks (moved out of GET /api/todos/board, Issue #71).
    try {
      await initTodo();
      await materializeRoutines(todoDate());
    } catch (error) {
      console.error("materializeRoutines failed", error);
    }
    // 2. R2: walk the bucket and record the day's object count and size.
    try {
      if (env.FILES) await reconcileStorageUsage(env.FILES, env.DB, "scheduled-r2-list");
    } catch (error) {
      console.error("reconcileStorageUsage failed", error);
    }
    // 3. D1 のテーブルごとの容量の概算(使用量画面の「主な保存データ」)。全テーブルを全件読むので1日1回だけ。
    try {
      await ensureSchema({ seed: false });
      await measureD1Tables(env.DB);
    } catch (error) {
      console.error("measureD1Tables failed", error);
    }
  },
};

export default worker;
