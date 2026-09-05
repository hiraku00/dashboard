import { portalSummary } from "@/app/lib/queries/portal";

export async function GET() {
  return Response.json(await portalSummary());
}
