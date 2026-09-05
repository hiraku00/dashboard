import { TextTubeApp, type Video } from "../text-tube-app";
import { listVideos } from "@/app/lib/queries/text-tube";

// Server Component: fetches the default (unfiltered) video list directly
// from D1 at render time -- see app/lib/queries/text-tube.ts for the shared
// query (app/api/text-tube/videos calls the same function).
export default async function TextTubePage() {
  const initialVideos = await fetchInitial();
  return <TextTubeApp initialVideos={initialVideos} />;
}

async function fetchInitial(): Promise<Video[] | null> {
  // Deliberately not surfaced as an error to TextTubeApp on failure -- see
  // the matching comment in app/page.tsx.
  try {
    const { videos } = await listVideos({});
    // listVideos() types each D1 column as `unknown` (see
    // app/lib/queries/text-tube.ts) because D1 does not give back typed
    // rows. The client already trusted this same JSON blindly via
    // readJson<T>() at the API boundary with no runtime validation;
    // asserting the shape here is the same level of trust, just applied
    // before the JSON round-trip instead of after it -- see the matching
    // comment in app/watch-list/page.tsx.
    return videos as unknown as Video[];
  } catch {
    return null;
  }
}
