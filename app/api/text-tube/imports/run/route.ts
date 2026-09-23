import { route } from "@/app/lib/route";
import { runTextTubeImport } from "@/app/lib/text-tube-import";

export const POST = route(async (request: Request) => {
  const body = (await request.json().catch(() => null)) as
    | { youtubeVideoId?: unknown; itemId?: unknown }
    | null;
  const youtubeVideoId =
    typeof body?.youtubeVideoId === "string" ? body.youtubeVideoId : "";
  if (!youtubeVideoId)
    return Response.json({ error: "youtubeVideoIdを指定してください。" }, { status: 400 });
  const itemId = typeof body?.itemId === "string" ? body.itemId : null;
  const result = await runTextTubeImport(youtubeVideoId, itemId);
  return Response.json(result);
});
