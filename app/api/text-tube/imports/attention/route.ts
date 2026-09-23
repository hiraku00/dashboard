import { route } from "@/app/lib/route";
import { pendingTextTubeImports } from "@/app/lib/text-tube-import";

export const GET = route(async () => {
  return Response.json({ items: await pendingTextTubeImports() });
});
