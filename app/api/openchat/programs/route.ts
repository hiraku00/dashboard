import { listPrograms } from "@/app/lib/queries/openchat";
import { route } from "@/app/lib/route";

/** 画面用の一覧。ちきりんさんのノート・コメントだけを返す(ほかの人のコメントは含めない)。 */
export const GET = route(async (request: Request) => {
  const { searchParams } = new URL(request.url);
  const page = await listPrograms({
    q: searchParams.get("q"),
    kind: searchParams.get("kind"),
    cursor: searchParams.get("cursor"),
    limit: Number(searchParams.get("limit")) || undefined,
  });
  return Response.json(page);
});
