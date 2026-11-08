import { lidoRewards } from "@/app/lib/queries/manage-asset";
import { route } from "@/app/lib/route";
import { assetWalletFor } from "@/app/lib/queries/asset-wallet";

export const GET = route(async (request: Request) => Response.json({ rows: await lidoRewards((await assetWalletFor(request.headers.get("cookie"))).db) }));
