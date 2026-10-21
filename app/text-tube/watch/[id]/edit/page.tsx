import { TextTubeVideoEditApp } from "../../../video-edit-app";

// The form loads the video and its detailed script itself (see
// video-edit-app.tsx): the script lives in R2 and is read only here.
export default async function TextTubeEditVideoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TextTubeVideoEditApp id={id} />;
}
