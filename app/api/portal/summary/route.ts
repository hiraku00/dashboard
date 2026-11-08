import { portalSummary } from "@/app/lib/queries/portal";
import { route } from "@/app/lib/route";
import { assetWalletFor } from "@/app/lib/queries/asset-wallet";

export const GET = route(async (request: Request) => {
  // ホームの資産合計も、Manage Asset で表示中のウォレットに合わせる（本番の合計がホームから見えないように）。
  return Response.json(await portalSummary((await assetWalletFor(request.headers.get("cookie"))).db));
});
