import { TextTubeApp, type VideoListItem } from "../text-tube-app";
import { listViewFromParams, type ListView } from "@/app/lib/text-tube-list-view";
import { listVideos } from "@/app/lib/queries/text-tube";

// Server Component: fetches the video list directly
// from D1 at render time -- see app/lib/queries/text-tube.ts for the shared
// query (app/api/text-tube/videos calls the same function).
export default async function TextTubePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // 一覧の状態（検索語・並び順・チャンネル・未読のみ）は URL のクエリにある（text-tube-app.tsx が書く）。
  // サーバーも同じ q と unread で読むので、戻ってきたときや再読み込みのときに、最初から同じ一覧が出る。
  const params = await searchParams;
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;
  const view = listViewFromParams({ q: one(params.q), sort: one(params.sort), channel: one(params.channel), unread: one(params.unread) });
  const initial = await fetchInitial(view);
  return <TextTubeApp initialVideos={initial?.videos ?? null} initialHasMore={initial?.hasMore ?? false} initialView={view} />;
}

async function fetchInitial(view: ListView): Promise<{ videos: VideoListItem[]; hasMore: boolean } | null> {
  // Deliberately not surfaced as an error to TextTubeApp on failure -- see
  // the matching comment in app/page.tsx.
  try {
    const { videos, hasMore } = await listVideos({ q: view.q, unread: view.unread });
    // listVideos() types each D1 column as `unknown` (see
    // app/lib/queries/text-tube.ts) because D1 does not give back typed
    // rows. The client already trusted this same JSON blindly via
    // readJson<T>() at the API boundary with no runtime validation;
    // asserting the shape here is the same level of trust, just applied
    // before the JSON round-trip instead of after it -- see the matching
    // comment in app/watch-list/page.tsx.
    return { videos: videos as unknown as VideoListItem[], hasMore };
  } catch {
    return null;
  }
}
