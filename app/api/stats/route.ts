import { watchListStats } from "@/app/lib/queries/watch-list";
import { route } from "@/app/lib/route";

export const GET = route(async () => {
  return Response.json(await watchListStats());
});
