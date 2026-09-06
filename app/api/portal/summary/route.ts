import { portalSummary } from "@/app/lib/queries/portal";
import { route } from "@/app/lib/route";

export const GET = route(async () => {
  return Response.json(await portalSummary());
});
