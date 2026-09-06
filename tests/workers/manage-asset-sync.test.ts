import { beforeAll, expect, test } from "vitest";
import { ensureSchema } from "@/db";
import { GET as historyGet } from "@/app/api/manage-asset/history/route";
import { POST as syncPost } from "@/app/api/manage-asset/sync/route";

// Replaces tests/rendered-html.test.mjs's "keeps Manage Asset positions
// attached to one D1 snapshot" (Issue #94, part of Issue #80's original
// Stage 4 scope). That test only grepped app/api/manage-asset/history/route.ts
// for `s.id AS snapshot_id` / `String(position.snapshot_id ?? "")` and
// asserted the absence of an old composite-key grouping expression -- it
// never actually synced two sources and confirmed their positions come back
// correctly separated. This does, against a real D1 and R2 (the sync route
// also archives the raw payload to R2 via app/lib/portal.ts's
// putPortalObject()).

beforeAll(async () => {
  await ensureSchema({ seed: false });
});

async function sync(body: Record<string, unknown>) {
  const response = await syncPost(
    new Request("http://x/api/manage-asset/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { response, body: await response.json() as Record<string, unknown> };
}

test("two wallets synced on the same date keep their positions correctly separated in /history", async () => {
  const clientRunId = crypto.randomUUID();
  const { response: started } = await sync({ action: "start", clientRunId, sourceCount: 2 });
  expect(started.status).toBe(200);

  const asOfDate = "2026-01-15";
  const { response: walletA } = await sync({
    action: "source",
    clientRunId,
    source: { sourceId: "sync-test-wallet-a", sourceType: "wallet", provider: "manual", displayName: "Wallet A" },
    snapshot: { capturedAt: `${asOfDate}T10:00:00Z`, asOfDate, totalUsd: 1000, tokens: [{ symbol: "ETH", amount_value: 2, usd_value_display: 1000 }] },
  });
  expect(walletA.status).toBe(200);

  const { response: walletB } = await sync({
    action: "source",
    clientRunId,
    source: { sourceId: "sync-test-wallet-b", sourceType: "wallet", provider: "manual", displayName: "Wallet B" },
    snapshot: { capturedAt: `${asOfDate}T10:05:00Z`, asOfDate, totalUsd: 2000, tokens: [{ symbol: "BTC", amount_value: 1, usd_value_display: 2000 }] },
  });
  expect(walletB.status).toBe(200);

  const { response: completed } = await sync({ action: "complete", clientRunId });
  expect(completed.status).toBe(200);

  const history = await historyGet(new Request(`http://x/api/manage-asset/history?days=all`));
  expect(history.status).toBe(200);
  const { snapshots } = (await history.json()) as { snapshots: Array<{ wallet_id: string; tokens: Array<{ symbol: string }> }> };

  const snapshotA = snapshots.find((snapshot) => snapshot.wallet_id === "sync-test-wallet-a");
  const snapshotB = snapshots.find((snapshot) => snapshot.wallet_id === "sync-test-wallet-b");
  expect(snapshotA, "expected wallet A's snapshot to appear in /history").toBeTruthy();
  expect(snapshotB, "expected wallet B's snapshot to appear in /history").toBeTruthy();

  // The regression this guards against: grouping positions to snapshots by a
  // composite key built from visible fields (source_id/as_of_date/captured_at)
  // instead of the snapshot's own id. Both wallets share the same as_of_date
  // here and were captured seconds apart -- exactly whichever attributes a
  // naive composite key would most plausibly confuse across two records
  // synced moments apart in the same run.
  expect(snapshotA!.tokens.map((token) => token.symbol)).toEqual(["ETH"]);
  expect(snapshotB!.tokens.map((token) => token.symbol)).toEqual(["BTC"]);
});
