import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { clean, currentStorageBytes, putPortalObject } from "@/app/lib/portal";
import { normalizeSyncedPositions } from "@/app/lib/manage-asset-core";
import { summarizeRun } from "@/app/lib/sync-summary";

// One request carries every source of a run, so cap it: the Workers Free plan
// allows 10ms of CPU per invocation, and the collector chunks well below this.
const MAX_BATCH_ENTRIES = 50;

function containsCredential(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredential);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => /api.?secret|api.?key|passphrase|private.?key|credential/i.test(key) || containsCredential(child));
}

type Entry = { source?: Record<string, unknown>; snapshot?: Record<string, unknown>; positions?: unknown[] };
type Body = Entry & { action?: string; clientRunId?: unknown; clientVersion?: unknown; sourceCount?: unknown; entries?: unknown[]; raw?: Record<string, unknown> };

/** Rejected payload rather than a server fault: a 400 for a single source, one failed row inside a batch. */
class SyncEntryError extends Error {}

/** Store one source's snapshot, raw object and positions. Both the single-source
 *  and the batch action go through here so the two paths cannot drift apart.
 *  knownUsedBytes threads the batch's running R2 total through; when omitted,
 *  the storage total is measured for this call alone (the legacy path). */
async function storeEntry(runId: string, entry: Entry, now: string, knownUsedBytes?: number) {
  if (!entry.source || !entry.snapshot) throw new SyncEntryError("source同期データが不正です。秘密情報は送信しないでください。");
  const sourceId = clean(entry.source.sourceId ?? entry.source.id, 200); const provider = clean(entry.source.provider, 100); const displayName = clean(entry.source.displayName ?? entry.source.name, 250);
  const capturedAt = clean(entry.snapshot.capturedAt, 50); const asOfDate = clean(entry.snapshot.asOfDate, 10);
  if (!sourceId || !provider || !displayName || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate) || !capturedAt) throw new SyncEntryError("sourceId、provider、displayName、capturedAt、asOfDateが必要です。");
  const sourceAddress = clean(entry.source.publicAddress ?? entry.source.address, 300); const sourceType = clean(entry.source.sourceType, 60) || "unknown";
  await env.DB.prepare(`INSERT INTO asset_sources (id,source_type,provider,display_name,public_address,enabled,created_at) VALUES (?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET source_type=excluded.source_type,provider=excluded.provider,display_name=excluded.display_name,public_address=excluded.public_address`).bind(sourceId,sourceType,provider,displayName,sourceAddress,now).run();
  const rawJson = JSON.stringify({ source: entry.source, snapshot: entry.snapshot, positions: entry.positions ?? [] }); const rawBody = new TextEncoder().encode(rawJson).buffer;
  // Keyed by date and source rather than by run: a same-day re-sync overwrites
  // its own raw object instead of leaving 8-20 copies a day in R2, matching the
  // one-snapshot-per-source-per-date rule the D1 rows now follow.
  const key = `manage-asset/raw/${asOfDate.replaceAll("-", "/")}/${sourceId}.json`;
  let stored: { key: string; size: number; sha256: string; usedBytes: number } | null = null; let storageStatus = "local_only";
  try { stored = await putPortalObject({ key, body: rawBody, category: "manage-asset/raw", contentType: "application/json", expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(), knownUsedBytes }); storageStatus = "stored"; } catch (error) { if (!(error instanceof Error) || !error.message.includes("安全上限")) throw error; }
  const totals = entry.snapshot as Record<string, unknown>; const totalUsd = Number(totals.totalUsd ?? totals.total_usd ?? 0) || 0; const totalJpy = Number(totals.totalJpy ?? totals.total_jpy ?? 0) || 0; const fx = Number(totals.fxUsdjpy ?? totals.fx_usdjpy ?? 0) || null;
  // One snapshot per source and date. A later sync on the same day replaces the
  // row it already wrote, which is what both readers resolve to anyway; it also
  // makes a retried POST (the collector retries on timeout, and the request is
  // not idempotent) unable to duplicate a snapshot.
  const upserted = await env.DB.prepare(`INSERT INTO asset_snapshots (id,run_id,source_id,captured_at,as_of_date,total_usd,total_jpy,fx_usdjpy,raw_object_key,raw_sha256,raw_size,raw_storage_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_id,as_of_date) DO UPDATE SET run_id=excluded.run_id,captured_at=excluded.captured_at,total_usd=excluded.total_usd,total_jpy=excluded.total_jpy,fx_usdjpy=excluded.fx_usdjpy,raw_object_key=excluded.raw_object_key,raw_sha256=excluded.raw_sha256,raw_size=excluded.raw_size,raw_storage_status=excluded.raw_storage_status
    RETURNING id`).bind(crypto.randomUUID(),runId,sourceId,capturedAt,asOfDate,totalUsd,totalJpy,fx,stored?.key ?? null,stored?.sha256 ?? null,stored?.size ?? rawBody.byteLength,storageStatus).all<{ id: string }>();
  const snapshotId = String(upserted.results?.[0]?.id ?? "");
  if (!snapshotId) throw new SyncEntryError("スナップショットを保存できませんでした。");
  await env.DB.batch([
    env.DB.prepare("UPDATE asset_sources SET last_success_at=? WHERE id=?").bind(capturedAt,sourceId),
    // The upsert may have reused an existing snapshot row, whose positions now
    // describe the earlier sync. Replace them rather than adding to them.
    env.DB.prepare("DELETE FROM asset_positions WHERE snapshot_id=?").bind(snapshotId),
  ]);
  const suppliedPositions = (Array.isArray(entry.positions) ? entry.positions : []).filter((position): position is Record<string, unknown> => Boolean(position && typeof position === "object"));
  // A wallet's stETH is nested under protocols[].panels[].assets[] in the local
  // DeBank snapshot. Never rely only on the flattened positions payload here.
  const positions = normalizeSyncedPositions(entry.source, entry.snapshot, suppliedPositions);
  const statements = positions.slice(0, 2000).map((position) => env.DB.prepare("INSERT INTO asset_positions (id,snapshot_id,symbol,quantity,price_usd,value_usd,value_jpy,location_type,protocol,position_type,is_debt) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),snapshotId,clean(position.symbol,100)||"UNKNOWN",position.quantity ?? 0,position.quantity && position.valueUsd ? position.valueUsd / position.quantity : null,position.valueUsd,fx ? position.valueUsd * fx : null,position.locationType,clean(position.protocol,200),position.positionType,position.positionType === "debt" ? 1 : 0));
  for (let start = 0; start < statements.length; start += 50) await env.DB.batch(statements.slice(start,start+50));
  return { sourceId, snapshotId, rawStorageStatus: storageStatus, usedBytes: stored?.usedBytes ?? knownUsedBytes };
}

export async function GET() {
  await ensureSchema({ seed: false });
  const latest = (await env.DB.prepare("SELECT * FROM asset_sync_runs ORDER BY received_at DESC LIMIT 1").all<Record<string, unknown>>()).results?.[0] ?? null;
  return Response.json({ ok: true, latest });
}

export async function POST(request: Request) {
  // Cloudflare Access validates the Service Token at the edge. Its client-secret
  // headers are intentionally not forwarded to the Worker, so do not repeat the
  // header check here. This route must remain covered by the Access application.
  await ensureSchema({ seed: false });
  const body = await request.json().catch(() => null) as Body | null;
  if (!body || typeof body.action !== "string" || typeof body.clientRunId !== "string") return Response.json({ error: "actionとclientRunIdが必要です。" }, { status: 400 });
  const clientRunId = clean(body.clientRunId, 200); const now = new Date().toISOString();

  if (body.action === "start") {
    if ((await env.DB.prepare("SELECT id FROM asset_sync_runs WHERE client_run_id=?").bind(clientRunId).all()).results?.length) return Response.json({ error: "この同期はすでに開始されています。" }, { status: 409 });
    const runId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO asset_sync_runs (id,client_run_id,client_version,started_at,status,source_count,received_at) VALUES (?,?,?,?,?,?,?)").bind(runId,clientRunId,clean(body.clientVersion,100),now,"started",Math.max(0,Number(body.sourceCount)||0),now).run();
    return Response.json({ runId });
  }

  const run = (await env.DB.prepare("SELECT id,status,source_count FROM asset_sync_runs WHERE client_run_id=?").bind(clientRunId).all<{ id: string; status: string; source_count: number }>()).results?.[0];
  if (!run) return Response.json({ error: "同期runが見つかりません。" }, { status: 404 });
  if (body.action === "complete") {
    // A source that failed in the "sources" batch never wrote a snapshot, so
    // the shortfall against the declared source_count is the error count.
    // This used to record success_count = the snapshot total and error_count =
    // a literal 0, which made a partially failed run indistinguishable from a
    // clean one in the only record that outlives the run.
    const counts = (await env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN raw_storage_status='stored' THEN 1 ELSE 0 END) AS raw_stored FROM asset_snapshots WHERE run_id=?").bind(run.id).all<{ total: number; raw_stored: number }>()).results?.[0];
    const summary = summarizeRun({
      declaredSourceCount: Number(run.source_count ?? 0),
      snapshotCount: Number(counts?.total ?? 0),
      rawStoredCount: Number(counts?.raw_stored ?? 0),
    });
    await env.DB.prepare("UPDATE asset_sync_runs SET completed_at=?,status=?,success_count=?,error_count=? WHERE id=?").bind(now,summary.status,summary.successCount,summary.errorCount,run.id).run();
    return Response.json({ ok: summary.errorCount === 0, runId: run.id, ...summary });
  }

  if (body.action === "sources") {
    const entries = Array.isArray(body.entries) ? body.entries : null;
    if (!entries?.length) return Response.json({ error: "entriesが必要です。" }, { status: 400 });
    if (entries.length > MAX_BATCH_ENTRIES) return Response.json({ error: `entriesは1リクエストあたり${MAX_BATCH_ENTRIES}件までです。` }, { status: 400 });
    if (containsCredential(body)) return Response.json({ error: "source同期データが不正です。秘密情報は送信しないでください。" }, { status: 400 });
    // Measure the R2 total once for the whole batch instead of once per source;
    // storeEntry threads the running total forward so the 8GB cap still counts
    // everything added earlier in this same request.
    let usedBytes: number | undefined = (await currentStorageBytes()).bytes;
    const results: Array<Record<string, unknown>> = [];
    for (const raw of entries) {
      const entry = (raw && typeof raw === "object" ? raw : {}) as Entry;
      try {
        const stored = await storeEntry(run.id, entry, now, usedBytes);
        usedBytes = stored.usedBytes ?? usedBytes;
        results.push({ sourceId: stored.sourceId, snapshotId: stored.snapshotId, rawStorageStatus: stored.rawStorageStatus });
      } catch (error) {
        // One bad source must not discard the sources that already stored, and
        // must not hide which one failed: report it per row and keep going.
        results.push({ sourceId: clean(entry.source?.sourceId ?? entry.source?.id, 200), error: error instanceof Error ? error.message : "同期に失敗しました。" });
      }
    }
    return Response.json({ ok: results.every((result) => !result.error), runId: run.id, results });
  }

  if (body.action !== "source" || !body.source || !body.snapshot || containsCredential(body)) return Response.json({ error: "source同期データが不正です。秘密情報は送信しないでください。" }, { status: 400 });
  try {
    const stored = await storeEntry(run.id, body, now);
    return Response.json({ ok: true, runId: run.id, snapshotId: stored.snapshotId, sourceId: stored.sourceId, rawStorageStatus: stored.rawStorageStatus });
  } catch (error) {
    if (error instanceof SyncEntryError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
