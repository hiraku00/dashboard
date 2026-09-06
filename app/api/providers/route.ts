import { route } from "@/app/lib/route";
export const GET = route(async () => Response.json({ providers: [{ provider: "binance", label: "Binance" }, { provider: "bitflyer", label: "bitFlyer" }, { provider: "bybit", label: "Bybit" }, { provider: "aave", label: "Aave" }] }));
