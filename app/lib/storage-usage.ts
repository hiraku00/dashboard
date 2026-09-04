/** Walks the whole R2 bucket and records its object count and total size as
 *  that day's row in storage_usage_daily.
 *
 *  Two callers need this: the daily cron (worker/index.ts's scheduled handler)
 *  and the manual /api/cron/reconcile-storage endpoint. They had byte-identical
 *  copies of the loop and the upsert, differing only in the `source` value they
 *  stamp on the row -- which is a real distinction (it says which path produced
 *  the number), so it stays a parameter.
 *
 *  Bindings are passed in rather than imported from "cloudflare:workers":
 *  worker/index.ts is bundled by vite/vinext as the worker entry and takes its
 *  env from the handler argument, so this module has to stay free of that
 *  import to be usable from both sides. */
export async function reconcileStorageUsage(
  bucket: R2Bucket,
  db: D1Database,
  source: string,
) {
  let cursor: string | undefined;
  let count = 0;
  let bytes = 0;
  do {
    const page = await bucket.list({ cursor, limit: 1000 });
    for (const object of page.objects) {
      count += 1;
      bytes += object.size;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const now = new Date().toISOString();
  const date = now.slice(0, 10);
  await db
    .prepare(
      "INSERT INTO storage_usage_daily (usage_date,object_count,payload_bytes,source,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(usage_date) DO UPDATE SET object_count=excluded.object_count,payload_bytes=excluded.payload_bytes,source=excluded.source,updated_at=excluded.updated_at",
    )
    .bind(date, count, bytes, source, now)
    .run();
  return { date, count, bytes };
}
