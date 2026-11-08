import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { ensureSchema } from "@/db";
import { GET as historyGet } from "@/app/api/manage-asset/history/route";
import { GET as stateGet } from "@/app/api/manage-asset/state/route";
import { GET as settingsGet, POST as settingsPost } from "@/app/api/manage-asset/settings/route";
import { GET as syncGet, POST as syncPost } from "@/app/api/manage-asset/sync/route";
import { portalSummary } from "@/app/lib/queries/portal";
import { assetWalletFor } from "@/app/lib/queries/asset-wallet";
import { wallet2Address } from "@/app/lib/manage-asset-wallet2";

// ウォレット2（ダミーデータ）は、朝の同期のたびに本番と同じ形で、通貨ごとの倍率を
// 掛けて書かれる。本番の同期を1回流して、ウォレット2の DB に同じ形・倍率どおりのデータが
// でき、設定で読む DB が切り替わることを確かめる。

const REAL_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const asOfDate = "2026-02-01";

beforeAll(async () => {
  await ensureSchema({ seed: false });
});

async function sync(body: Record<string, unknown>) {
  const response = await syncPost(new Request("http://x/api/manage-asset/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { response, body: await response.json() as Record<string, unknown> };
}

beforeAll(async () => {
  const clientRunId = crypto.randomUUID();
  expect((await sync({ action: "start", clientRunId, sourceCount: 2 })).response.status).toBe(200);
  const { response, body } = await sync({
    action: "sources",
    clientRunId,
    entries: [
      {
        source: { sourceId: "w2-test-wallet", sourceType: "wallet", provider: "debank", displayName: "Main", publicAddress: REAL_ADDRESS },
        snapshot: {
          capturedAt: `${asOfDate}T00:00:00Z`, asOfDate, totalUsd: "4030", totalJpy: 604500, fxUsdjpy: 150,
          wallet_id: "w2-test-wallet", address: REAL_ADDRESS, total_usd: "4030", fx_usdjpy: 150,
          tokens: [
            { symbol: "ETH", amount_display: "0.0100", usd_value_display: "$20.00" },
            { symbol: "USDT", amount_display: "10", usd_value_display: "$10.00" },
          ],
          protocols: [{ name: "Lido", usd_value: "4000", panels: [{ display_text: "", assets: [{ asset_symbol: "stETH", amount_value: 1, usd_value: 4000 }] }] }],
        },
        positions: [
          { symbol: "ETH", amount_display: "0.0100", usd_value_display: "$20.00" },
          { symbol: "USDT", amount_display: "10", usd_value_display: "$10.00" },
        ],
      },
      {
        source: { sourceId: "w2-test-exchange", sourceType: "exchange", provider: "bitflyer", displayName: "bitFlyer" },
        snapshot: {
          capturedAt: `${asOfDate}T00:01:00Z`, asOfDate, totalUsd: "1000", totalJpy: 150000, fxUsdjpy: 150,
          totals: { net_asset_usd: "1000", gross_asset_usd: "1000", liability_usd: "0" },
          positions: [{ symbol: "BTC", quantity: "0.01", net_quantity: "0.01", price: "100000", usd_value: "1000", is_liability: false }],
        },
        positions: [{ symbol: "BTC", quantity: "0.01", net_quantity: "0.01", price: "100000", usd_value: "1000", is_liability: false }],
      },
    ],
  });
  expect(response.status).toBe(200);
  expect(body.ok).toBe(true);
  expect((await sync({ action: "complete", clientRunId })).response.status).toBe(200);
});

test("the morning sync also writes wallet 2, scaled per currency, in the same tables", async () => {
  const real = (await env.DB.prepare("SELECT total_usd,total_jpy,fx_usdjpy FROM asset_snapshots WHERE source_id='w2-test-wallet'").first()) as Record<string, number>;
  const demo = (await env.DB_WALLET2.prepare("SELECT total_usd,total_jpy,fx_usdjpy,raw_object_key FROM asset_snapshots WHERE source_id='w2-test-wallet'").first()) as Record<string, number | null>;
  expect(real.total_usd).toBe(4030);
  const delta = 20 * 99 + 10 * 999 + 4000 * 7;
  expect(demo.total_usd).toBe(4030 + delta);
  expect(demo.total_jpy).toBeCloseTo(604500 + delta * 150, 6);
  expect(demo.fx_usdjpy).toBe(150);
  // Wallet 2 does not archive its raw payload to R2.
  expect(demo.raw_object_key).toBe(null);

  const positions = (await env.DB_WALLET2.prepare("SELECT p.symbol,p.quantity,p.value_usd,p.price_usd FROM asset_positions p JOIN asset_snapshots s ON s.id=p.snapshot_id ORDER BY p.symbol").all()).results as Array<Record<string, number | string>>;
  const bySymbol = Object.fromEntries(positions.map((row) => [row.symbol, row]));
  expect(bySymbol.ETH).toMatchObject({ quantity: 1, value_usd: 2000 });
  expect(bySymbol.USDT).toMatchObject({ quantity: 10000, value_usd: 10000 });
  expect(bySymbol.stETH).toMatchObject({ quantity: 8, value_usd: 32000 });
  expect(bySymbol.BTC).toMatchObject({ quantity: 0.2, value_usd: 20000, price_usd: 100000 });

  const exchange = (await env.DB_WALLET2.prepare("SELECT total_usd FROM asset_snapshots WHERE source_id='w2-test-exchange'").first()) as { total_usd: number };
  expect(exchange.total_usd).toBe(20000);
});

test("wallet 2 shows a look-alike address and the real exchange name", async () => {
  const sources = (await env.DB_WALLET2.prepare("SELECT id,display_name,public_address FROM asset_sources ORDER BY id").all()).results as Array<Record<string, string>>;
  expect(sources.find((row) => row.id === "w2-test-wallet")?.public_address).toBe(wallet2Address(REAL_ADDRESS));
  expect(sources.find((row) => row.id === "w2-test-wallet")?.public_address).not.toBe(REAL_ADDRESS);
  expect(sources.find((row) => row.id === "w2-test-exchange")?.display_name).toBe("bitFlyer");
});

test("wallet 2's run mirrors production's run result", async () => {
  const real = await env.DB.prepare("SELECT id,status,success_count,error_count FROM asset_sync_runs ORDER BY received_at DESC LIMIT 1").first();
  const demo = await env.DB_WALLET2.prepare("SELECT id,status,success_count,error_count FROM asset_sync_runs WHERE id=?").bind((real as { id: string }).id).first();
  expect(demo).toEqual(real);
});

const chooseWallet = async (wallet: string) => {
  const response = await settingsPost(new Request("http://x/api/manage-asset/settings", { method: "POST", body: JSON.stringify({ defaultWallet: wallet }) }));
  expect(response.status).toBe(200);
};

test("the setting picks which DB the API reads", async () => {
  const total = async () => {
    const state = await (await stateGet()).json() as { snapshots: Array<{ wallet_id: string; total_usd: number; address: string }> };
    return state.snapshots.find((row) => row.wallet_id === "w2-test-wallet");
  };
  // Unset means wallet 1.
  expect(await (await settingsGet()).json()).toEqual({ defaultWallet: "1" });
  expect((await total())?.total_usd).toBe(4030);

  await chooseWallet("2");
  expect((await total())?.total_usd).toBe(4030 + 20 * 99 + 10 * 999 + 4000 * 7);
  expect((await total())?.address).toBe(wallet2Address(REAL_ADDRESS));
  const history = await (await historyGet(new Request("http://x/api/manage-asset/history?days=all&fields=currency"))).json() as { snapshots: Array<{ wallet_id: string; tokens: Array<{ symbol: string; amount_value: number }> }> };
  const tokens = history.snapshots.find((row) => row.wallet_id === "w2-test-wallet")?.tokens ?? [];
  expect(tokens.find((token) => token.symbol === "stETH")?.amount_value).toBe(8);
  // The data-update tab's last run follows the wallet; the resync request stays production's.
  const syncBody = await (await syncGet()).json() as { latest: { id: string } | null };
  expect(syncBody.latest?.id).toBeTruthy();

  expect((await settingsPost(new Request("http://x/api/manage-asset/settings", { method: "POST", body: JSON.stringify({ defaultWallet: "3" }) }))).status).toBe(400);
  await chooseWallet("1");
  expect((await total())?.total_usd).toBe(4030);
});

test("the home page's asset total follows the chosen wallet", async () => {
  const real = await portalSummary((await assetWalletFor()).db);
  await chooseWallet("2");
  const demo = await portalSummary((await assetWalletFor()).db);
  await chooseWallet("1");
  expect(demo.assets.totalUsd).toBeGreaterThan(real.assets.totalUsd);
  expect(demo.assets.sourceCount).toBe(real.assets.sourceCount);
  // Everything that is not an asset is the same either way.
  expect({ ...demo, assets: null }).toEqual({ ...real, assets: null });
});
