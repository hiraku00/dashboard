import { TextTubeWatchApp } from "../watch-app";
import { getVideoDetail } from "@/app/lib/queries/text-tube";

// Server Component: fetches the video (D1) and its document (R2) directly
// at render time -- see getVideoDetail() in app/lib/queries/text-tube.ts
// (app/api/text-tube/videos/[id] and .../document call the same underlying
// helpers, so this cannot drift from what those routes return).
export default async function TextTubeWatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const initial = await fetchInitial(id);
  return (
    <TextTubeWatchApp
      id={id}
      initialVideo={initial.video}
      initialDocument={initial.document}
      initialError={initial.error}
    />
  );
}

async function fetchInitial(id: string): Promise<{ video: Record<string, unknown> | null; document: string; error: string }> {
  try {
    const detail = await getVideoDetail(id);
    // A real 404 (the video does not exist) is surfaced as an error so the
    // client does not retry a fetch that would just 404 again -- unlike a
    // thrown exception below, which leaves both video and error empty and
    // falls through to the client's own fetch, matching the pre-RSC
    // fallback used throughout this migration (see app/page.tsx).
    if (!detail) return { video: null, document: "", error: "動画が見つかりません。" };
    // getVideoDetail() types each column as `unknown` because D1 does not
    // give back typed rows. The client already trusted this same JSON
    // blindly via readJson<T>() at the API boundary with no runtime
    // validation -- see the matching comment in app/watch-list/page.tsx.
    return { video: detail.video as unknown as Record<string, unknown>, document: detail.document, error: "" };
  } catch {
    return { video: null, document: "", error: "" };
  }
}
