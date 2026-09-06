/** Pure validation/normalization for a TextTube video's write path -- no
 *  D1, no I/O. Kept separate from app/api/text-tube/videos/route.ts (which
 *  does the actual D1 insert) for the same reason as
 *  app/lib/watch-list-item-input.ts: a module that imports
 *  "cloudflare:workers" at the top level cannot be loaded outside the
 *  Workers runtime at all, let alone unit tested under plain `node --test`.
 *
 *  Imports app/lib/text.ts by relative path with an explicit .ts extension
 *  rather than the "@/..." alias -- see the matching comment in
 *  app/lib/watch-list-item-input.ts. */
import { clean } from "./text.ts";

export type VideoInput = {
  title: string;
  channelName: string;
  thumbnailUrl: string;
  originalUrl: string;
  summary: string;
  publishedAt: string | null;
  viewCount: number;
  channelThumbnailUrl: string;
  duration: string;
};

/** app/api/text-tube/videos/route.ts's POST is the only caller. */
export function videoInput(body: Record<string, unknown>): { value?: VideoInput; error?: string } {
  const title = clean(body.title, 1000);
  if (!title) return { error: "タイトルは必須です。" };
  return {
    value: {
      title,
      channelName: clean(body.channelName, 500),
      thumbnailUrl: clean(body.thumbnailUrl, 2000),
      originalUrl: clean(body.originalUrl, 2000),
      summary: clean(body.summary, 30000),
      publishedAt: clean(body.publishedAt, 40) || null,
      viewCount: Math.max(0, Number(body.viewCount) || 0),
      channelThumbnailUrl: clean(body.channelThumbnailUrl, 2000),
      duration: clean(body.duration, 100),
    },
  };
}
