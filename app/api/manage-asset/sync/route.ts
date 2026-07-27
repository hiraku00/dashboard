import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { clean, putPortalObject } from "@/app/lib/portal";
import { normalizeSyncedPositions } from "@/app/lib/manage-asset-core";

function containsCredential(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredential);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => /api.?secret|api.?key|passphrase|private.?key|credential/i.test(key) || containsCredential(child));
}

type Body = { action?: string; clientRunId?: unknown; clientVersion?: unknown; sourceCount?: unknown; source?: Record<string, unknown>; snapshot?: Record<string, unknown>; positions?: unknown[]; raw?: Record<string, unknown> };

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

  const run = (await env.DB.prepare("SELECT id,status FROM asset_sync_runs WHERE client_run_id=?").bind(clientRunId).all<{ id: string; status: string }>()).results?.[0];
  if (!run) return Response.json({ error: "同期runが見つかりません。" }, { status: 404 });
  if (body.action === "complete") {
    const counts = (await env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN raw_storage_status='stored' THEN 1 ELSE 0 END) AS success FROM asset_snapshots WHERE run_id=?").bind(run.id).all<{ total: number; success: number }>()).results?.[0];
    await env.DB.prepare("UPDATE asset_sync_runs SET completed_at=?,status=?,success_count=?,error_count=? WHERE id=?").bind(now,"completed",Number(counts?.total??0),0,run.id).run();
    return Response.json({ ok: true, runId: run.id });
  }
  if (body.action !== "source" || !body.source || !body.snapshot || containsCredential(body)) return Response.json({ error: "source同期データが不正です。秘密情報は送信しないでください。" }, { status: 400 });
  const sourceId = clean(body.source.sourceId ?? body.source.id, 200); const provider = clean(body.source.provider, 100); const displayName = clean(body.source.displayName ?? body.source.name, 250);
  const capturedAt = clean(body.snapshot.capturedAt, 50); const asOfDate = clean(body.snapshot.asOfDate, 10);
  if (!sourceId || !provider || !displayName || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate) || !capturedAt) return Response.json({ error: "sourceId、provider、displayName、capturedAt、asOfDateが必要です。" }, { status: 400 });
  const sourceAddress = clean(body.source.publicAddress ?? body.source.address, 300); const sourceType = clean(body.source.sourceType, 60) || "unknown";
  await env.DB.prepare(`INSERT INTO asset_sources (id,source_type,provider,display_name,public_address,enabled,created_at) VALUES (?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET source_type=excluded.source_type,provider=excluded.provider,display_name=excluded.display_name,public_address=excluded.public_address`).bind(sourceId,sourceType,provider,displayName,sourceAddress,now).run();
  const snapshotId = crypto.randomUUID(); const rawJson = JSON.stringify({ source: body.source, snapshot: body.snapshot, positions: body.positions ?? [] }); const rawBody = new TextEncoder().encode(rawJson).buffer;
  const key = `manage-asset/raw/${asOfDate.replaceAll("-", "/")}/${run.id}/${sourceId}.json`;
  let stored: { key: string; size: number; sha256: string } | null = null; let storageStatus = "local_only";
  try { stored = await putPortalObject({ key, body: rawBody, category: "manage-asset/raw", contentType: "application/json", expiresAt: new Date(Date.now() + 365 * 86400000).toISOString() }); storageStatus = "stored"; } catch (error) { if (!(error instanceof Error) || !error.message.includes("安全上限")) throw error; }
  const totals = body.snapshot as Record<string, unknown>; const totalUsd = Number(totals.totalUsd ?? totals.total_usd ?? 0) || 0; const totalJpy = Number(totals.totalJpy ?? totals.total_jpy ?? 0) || 0; const fx = Number(totals.fxUsdjpy ?? totals.fx_usdjpy ?? 0) || null;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO asset_snapshots (id,run_id,source_id,captured_at,as_of_date,total_usd,total_jpy,fx_usdjpy,raw_object_key,raw_sha256,raw_size,raw_storage_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind(snapshotId,run.id,sourceId,capturedAt,asOfDate,totalUsd,totalJpy,fx,stored?.key ?? null,stored?.sha256 ?? null,stored?.size ?? rawBody.byteLength,storageStatus),
    env.DB.prepare("UPDATE asset_sources SET last_success_at=? WHERE id=?").bind(capturedAt,sourceId),
  ]);
  const suppliedPositions = (Array.isArray(body.positions) ? body.positions : []).filter((position): position is Record<string, unknown> => Boolean(position && typeof position === "object"));
  // A wallet's stETH is nested under protocols[].panels[].assets[] in the local
  // DeBank snapshot. Never rely only on the flattened positions payload here.
  const positions = normalizeSyncedPositions(body.source, body.snapshot, suppliedPositions);
  const statements = positions.slice(0, 2000).map((position) => env.DB.prepare("INSERT INTO asset_positions (id,snapshot_id,symbol,quantity,price_usd,value_usd,value_jpy,location_type,protocol,position_type,is_debt) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),snapshotId,clean(position.symbol,100)||"UNKNOWN",position.quantity ?? 0,position.quantity && position.valueUsd ? position.valueUsd / position.quantity : null,position.valueUsd,fx ? position.valueUsd * fx : null,position.locationType,clean(position.protocol,200),position.positionType,position.positionType === "debt" ? 1 : 0));
  for (let start = 0; start < statements.length; start += 50) await env.DB.batch(statements.slice(start,start+50));
  return Response.json({ ok: true, runId: run.id, snapshotId, sourceId, rawStorageStatus: storageStatus });
}
