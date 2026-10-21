import { TextTubeVideoEditApp } from "../../../video-edit-app";

// The form loads the video and its detailed script itself (see
// video-edit-app.tsx): the script lives in R2 and is read only here.
export default async function TextTubeEditVideoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  const [{ id }, { from }] = await Promise.all([params, searchParams]);
  return <TextTubeVideoEditApp id={id} fromList={from === "list"} />;
}
