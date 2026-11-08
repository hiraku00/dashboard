import { lidoRewards } from "@/app/lib/queries/manage-asset";
import { route } from "@/app/lib/route";
import { assetWalletFor } from "@/app/lib/queries/asset-wallet";

export const GET = route(async () => Response.json({ rows: await lidoRewards((await assetWalletFor()).db) }));
