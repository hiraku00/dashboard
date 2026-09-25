import { listPrograms } from "@/app/lib/queries/openchat";
import { route } from "@/app/lib/route";

/** 画面用の一覧。ちきりんのノート・コメントだけを返す(ほかの人のコメントは含めない)。 */
export const GET = route(async (request: Request) => {
  const { searchParams } = new URL(request.url);
  const page = await listPrograms({
    q: searchParams.get("q"),
    kind: searchParams.get("kind"),
    page: searchParams.get("page"),
    limit: Number(searchParams.get("limit")) || undefined,
  });
  return Response.json(page);
});
