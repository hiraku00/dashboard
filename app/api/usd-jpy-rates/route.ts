import { usdJpyRates } from "@/app/lib/queries/manage-asset";
import { route } from "@/app/lib/route";

export const GET = route(async () => Response.json({ rows: await usdJpyRates() }));
