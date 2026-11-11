/** Pure validation/normalization for a TextTube video's write path -- no
 *  D1, no I/O. Kept separate from app/api/text-tube/videos/route.ts (which
 *  does the actual D1 insert) for the same reason as
 *  app/lib/watch-list-item-input.ts: a module that imports
 *  "cloudflare:workers" at the top level cannot be loaded outside the
 *  Workers runtime at all, let alone unit tested under vitest's plain-Node "node" project.
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

/** 要約欄の上限(文字数)。以前は30,000文字で、超えた分を黙って切って
 *  保存していた -- HTML部品入りの長い記事が章の途中で切れ、切れた後ろは
 *  どこにも残らなかった。日本語20万文字でもUTF-8で約600KBで、D1の1行の
 *  上限(約2MB)に十分収まる。超えたときは切らずに保存をエラーにする。 */
export const SUMMARY_MAX_LENGTH = 200_000;

/** app/api/text-tube/videos/route.ts の POST と
 *  app/api/text-tube/videos/[id]/route.ts の PATCH の両方が通る。 */
export function videoInput(body: Record<string, unknown>): { value?: VideoInput; error?: string } {
  const title = clean(body.title, 1000);
  if (!title) return { error: "タイトルは必須です。" };
  const summaryLength = typeof body.summary === "string" ? body.summary.trim().length : 0;
  if (summaryLength > SUMMARY_MAX_LENGTH)
    return {
      error: `要約が長すぎます(${summaryLength.toLocaleString("ja-JP")}文字)。${SUMMARY_MAX_LENGTH.toLocaleString("ja-JP")}文字以内にしてください。`,
    };
  return {
    value: {
      title,
      channelName: clean(body.channelName, 500),
      thumbnailUrl: clean(body.thumbnailUrl, 2000),
      originalUrl: clean(body.originalUrl, 2000),
      summary: clean(body.summary, SUMMARY_MAX_LENGTH),
      publishedAt: clean(body.publishedAt, 40) || null,
      viewCount: Math.max(0, Number(body.viewCount) || 0),
      channelThumbnailUrl: clean(body.channelThumbnailUrl, 2000),
      duration: clean(body.duration, 100),
    },
  };
}
