/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

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
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    void _controller;
    void _ctx;
    if (!env.FILES || !env.DB) return;
    let cursor: string | undefined;
    let count = 0;
    let bytes = 0;
    do {
      const page = await env.FILES.list({ cursor, limit: 1000 });
      for (const object of page.objects) { count += 1; bytes += object.size; }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO storage_usage_daily (usage_date,object_count,payload_bytes,source,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(usage_date) DO UPDATE SET object_count=excluded.object_count,payload_bytes=excluded.payload_bytes,source=excluded.source,updated_at=excluded.updated_at")
      .bind(now.slice(0, 10), count, bytes, "scheduled-r2-list", now).run();
  },
};

export default worker;
