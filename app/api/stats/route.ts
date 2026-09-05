import { watchListStats } from "@/app/lib/queries/watch-list";

export async function GET() {
  return Response.json(await watchListStats());
}
