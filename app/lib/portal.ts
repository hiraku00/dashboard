import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";

export const R2_SOFT_LIMIT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_OBJECT_BYTES = 25 * 1024 * 1024;

export function clean(value: unknown, max = 4000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function sha256(body: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", body);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function currentStorageBytes() {
  await ensureSchema({ seed: false });
  const row = (await env.DB.prepare("SELECT COALESCE(SUM(size_bytes),0) AS bytes, COUNT(*) AS count FROM storage_objects WHERE deleted_at IS NULL").all<{ bytes: number; count: number }>()).results?.[0];
  return { bytes: Number(row?.bytes ?? 0), count: Number(row?.count ?? 0) };
}

export async function putPortalObject(args: { key: string; body: ArrayBuffer; category: string; contentType: string; sha?: string; expiresAt?: string | null; knownUsedBytes?: number }) {
  if (!env.FILES) throw new Error("R2 binding FILES is unavailable.");
  if (args.body.byteLength > MAX_OBJECT_BYTES) throw new Error("ファイルサイズが上限を超えています。");
  await ensureSchema({ seed: false });
  const previous = await env.DB.prepare("SELECT size_bytes FROM storage_objects WHERE object_key = ? AND deleted_at IS NULL").bind(args.key).all<{ size_bytes: number }>();
  const oldBytes = Number(previous.results?.[0]?.size_bytes ?? 0);
  // currentStorageBytes() aggregates the whole storage_objects table, so a
  // caller storing many objects in one request (the Manage Asset batch sync)
  // measures it once and threads the running total through knownUsedBytes.
  // The returned usedBytes is the new total, ready to pass to the next call.
  const usedBytes = args.knownUsedBytes ?? (await currentStorageBytes()).bytes;
  if (usedBytes - oldBytes + args.body.byteLength > R2_SOFT_LIMIT_BYTES) throw new Error("R2の安全上限（8GB）に達するため保存を停止しました。古い原本を整理してください。");
  const digest = args.sha ?? await sha256(args.body);
  await env.FILES.put(args.key, args.body, { httpMetadata: { contentType: args.contentType, contentEncoding: args.key.endsWith(".gz") ? "gzip" : undefined } });
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO storage_objects (object_key, category, size_bytes, sha256, content_type, created_at, expires_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(object_key) DO UPDATE SET category=excluded.category, size_bytes=excluded.size_bytes, sha256=excluded.sha256, content_type=excluded.content_type, created_at=excluded.created_at, expires_at=excluded.expires_at, deleted_at=NULL`)
    .bind(args.key, args.category, args.body.byteLength, digest, args.contentType, now, args.expiresAt ?? null).run();
  return { key: args.key, size: args.body.byteLength, sha256: digest, usedBytes: usedBytes - oldBytes + args.body.byteLength };
}

export async function getPortalObject(key: string) {
  if (!env.FILES) return null;
  return env.FILES.get(key);
}
