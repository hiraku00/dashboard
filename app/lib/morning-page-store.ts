/** モーニングページの D1 への書き込み(POST /api/morning-pages)。入力の検証は morning-page-input.ts の純関数に任せ、ここは保存だけを受け持つ。
 *
 *  先にまとめて既存の内容のハッシュを読み、変わっていないページは書かない(何度送り直してもよい)。
 *  書くのは変わった・新しいページだけを1回の DB.batch にまとめる(1回の呼び出しで50クエリまで、の無料枠に収まる件数)。 */

import { env } from "cloudflare:workers";
import { canonicalContent, normalizeMorningPage, type MorningPageInput } from "./morning-page-input.ts";

export type MorningIngestResult = { date: string; status: "created" | "updated" | "skipped" | "error"; error?: string };

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function ingestMorningPages(rawPages: unknown[]): Promise<MorningIngestResult[]> {
  const results: MorningIngestResult[] = [];
  const valid: MorningPageInput[] = [];
  const seen = new Set<string>();
  for (const raw of rawPages) {
    const normalized = normalizeMorningPage(raw);
    if (!normalized.ok) {
      results.push({ date: normalized.date, status: "error", error: normalized.error });
    } else if (seen.has(normalized.page.date)) {
      results.push({ date: normalized.page.date, status: "error", error: "同じdateが1リクエストに2回あります。" });
    } else {
      seen.add(normalized.page.date);
      valid.push(normalized.page);
    }
  }
  if (!valid.length) return results;

  const stored = new Map<string, string>();
  const placeholders = valid.map(() => "?").join(",");
  const rows = (await env.DB.prepare(`SELECT page_date, content_hash FROM morning_pages WHERE page_date IN (${placeholders})`)
    .bind(...valid.map((page) => page.date)).all<{ page_date: string; content_hash: string }>()).results ?? [];
  for (const row of rows) stored.set(row.page_date, row.content_hash);

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  const written: MorningIngestResult[] = [];
  for (const page of valid) {
    const hash = await sha256Hex(canonicalContent(page));
    if (stored.get(page.date) === hash) {
      results.push({ date: page.date, status: "skipped" });
      continue;
    }
    statements.push(env.DB.prepare(`INSERT INTO morning_pages (page_date,started_at,ended_at,minutes,place,chars,outfit_top,outfit_top_brand,outfit_middle,outfit_middle_brand,outfit_bottom,outfit_bottom_brand,
        yesterday,plan,notes,extracted,content_hash,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(page_date) DO UPDATE SET started_at=excluded.started_at,ended_at=excluded.ended_at,minutes=excluded.minutes,place=excluded.place,chars=excluded.chars,
        outfit_top=excluded.outfit_top,outfit_top_brand=excluded.outfit_top_brand,outfit_middle=excluded.outfit_middle,
        outfit_middle_brand=excluded.outfit_middle_brand,outfit_bottom=excluded.outfit_bottom,outfit_bottom_brand=excluded.outfit_bottom_brand,
        yesterday=excluded.yesterday,plan=excluded.plan,notes=excluded.notes,extracted=excluded.extracted,content_hash=excluded.content_hash,updated_at=excluded.updated_at`)
      .bind(page.date, page.startedAt, page.endedAt, page.minutes, page.place, page.chars, page.outfit.top.item, page.outfit.top.brand, page.outfit.middle.item, page.outfit.middle.brand,
        page.outfit.bottom.item, page.outfit.bottom.brand, JSON.stringify(page.yesterday), JSON.stringify(page.plan), JSON.stringify(page.notes),
        page.extracted ? 1 : 0, hash, now, now));
    written.push({ date: page.date, status: stored.has(page.date) ? "updated" : "created" });
  }
  if (statements.length) {
    try {
      await env.DB.batch(statements);
      results.push(...written);
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存に失敗しました。";
      results.push(...written.map((entry) => ({ date: entry.date, status: "error" as const, error: message })));
    }
  }
  return results.sort((a, b) => a.date.localeCompare(b.date));
}
