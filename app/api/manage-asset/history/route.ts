import { assetHistory } from "@/app/lib/queries/manage-asset";
import { route } from "@/app/lib/route";

// The read logic lives in app/lib/queries/manage-asset.ts so this endpoint and
// the /manage-asset page's Server Component produce the same shape.
// `?summary=1` returns only what the asset overview reads (ids, dates, totals) --
// see assetHistorySummary(). `?fields=currency` returns the rows with only what the
// per-currency history reads -- see manage-asset-history-fields.ts. Without either,
// the full rows come back, as always.
export const GET = route(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  return Response.json(await assetHistory(params.get("days"), {
    summary: params.get("summary") === "1",
    fields: params.get("fields") === "currency" ? "currency" : undefined,
  }));
});
