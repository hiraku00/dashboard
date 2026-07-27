#!/usr/bin/env node
import fs from "node:fs/promises";

const [inputPath, baseUrl = "http://127.0.0.1:8787"] = process.argv.slice(2);
const syncKey = process.env.PORTAL_SYNC_KEY;
if (!inputPath || !syncKey) {
  console.error("Usage: PORTAL_SYNC_KEY=... node scripts/sync-manage-asset.mjs snapshot.json [portal-url]");
  process.exit(1);
}
const payload = JSON.parse(await fs.readFile(inputPath, "utf8"));
const clientRunId = payload.clientRunId ?? `local-${Date.now()}`;
const headers = { "content-type": "application/json", "cf-access-client-id": process.env.CF_ACCESS_CLIENT_ID ?? "local", "cf-access-client-secret": syncKey };
const post = async (body) => { const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/manage-asset/sync`, { method: "POST", headers, body: JSON.stringify(body) }); const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.error ?? `sync failed: ${response.status}`); return result; };
const start = await post({ action: "start", clientRunId, clientVersion: "local-adapter/1", sourceCount: payload.sources?.length ?? 1 });
const sources = Array.isArray(payload.sources) ? payload.sources : [{ source: payload.source, snapshot: payload.snapshot, positions: payload.positions }];
for (const entry of sources) await post({ action: "source", clientRunId, source: entry.source, snapshot: entry.snapshot, positions: entry.positions ?? [] });
await post({ action: "complete", clientRunId });
console.log(JSON.stringify({ ok: true, runId: start.runId, sourceCount: sources.length }));
