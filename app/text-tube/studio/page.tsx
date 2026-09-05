import { TextTubeStudioApp } from "../studio-app";
import type { Video } from "../../text-tube-app";
import { listVideos } from "@/app/lib/queries/text-tube";

// Server Component: fetches the default (unfiltered) video list directly
// from D1 at render time -- see app/lib/queries/text-tube.ts for the shared
// query (app/api/text-tube/videos and app/text-tube/page.tsx call the same
// function).
export default async function TextTubeStudio() {
  const initialVideos = await fetchInitial();
  return <TextTubeStudioApp initialVideos={initialVideos} />;
}

async function fetchInitial(): Promise<Video[] | null> {
  // Deliberately not surfaced as an error to TextTubeStudioApp on failure --
  // see the matching comment in app/page.tsx.
  try {
    const { videos } = await listVideos({});
    // See the matching comment in app/text-tube/page.tsx about this cast.
    return videos as unknown as Video[];
  } catch {
    return null;
  }
}
