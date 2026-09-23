import { route } from "@/app/lib/route";
import { dismissTextTubeImport } from "@/app/lib/text-tube-import";

type Context = { params: Promise<{ id: string }> };

export const POST = route(async (_request: Request, context: Context) => {
  const { id } = await context.params;
  await dismissTextTubeImport(id);
  return Response.json({ ok: true });
});
