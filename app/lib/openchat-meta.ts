/** ちきりんオプチャの、人が編集する情報(放送局・その日の放送タイトル・リンク)の検証と整形。
 *  D1には触れない純粋なロジック(vitestの "node" project でテストする)。collector の同期データとは別のテーブル
 *  (openchat_note_meta)に保存するので、同期で上書きされない。 */

export const MAX_BROADCASTER = 40;
export const MAX_EPISODE_TITLE = 200;
export const MAX_LINKS = 5;
export const MAX_URL = 2000;
export const MAX_LINK_LABEL = 60;

export type MetaLink = { url: string; label: string };
export type Meta = { broadcaster: string; programName: string; episodeTitle: string; links: MetaLink[] };
export const EMPTY_META: Meta = { broadcaster: "", programName: "", episodeTitle: "", links: [] };

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim().slice(0, max) : "";
}

/** http(s) のURLだけ。それ以外(javascript: など)は受け付けない。 */
export function safeUrl(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > MAX_URL) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** 保存する値を作る。URLが不正なリンクがあれば、黙って捨てずにエラーにする。 */
export function normalizeMeta(input: unknown): { meta: Meta } | { error: string } {
  if (!input || typeof input !== "object") return { error: "入力が正しくありません。" };
  const body = input as Record<string, unknown>;
  const rawLinks = Array.isArray(body.links) ? body.links : [];
  if (rawLinks.length > MAX_LINKS) return { error: `リンクは${MAX_LINKS}件までです。` };
  const links: MetaLink[] = [];
  for (const item of rawLinks) {
    const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    if (!text(row.url, MAX_URL) && !text(row.label, MAX_LINK_LABEL)) continue;      // 空の行は無視
    const url = safeUrl(row.url);
    if (!url) return { error: "リンクのURLは http:// または https:// で始まる正しい形式にしてください。" };
    links.push({ url, label: text(row.label, MAX_LINK_LABEL) });
  }
  return { meta: { broadcaster: text(body.broadcaster, MAX_BROADCASTER), programName: text(body.programName, MAX_EPISODE_TITLE), episodeTitle: text(body.episodeTitle, MAX_EPISODE_TITLE), links } };
}

/** D1の行(links_json は文字列) → 画面・APIの形。壊れていても空として扱う。 */
export function metaFromRow(row: Record<string, unknown> | null | undefined): Meta {
  if (!row) return { ...EMPTY_META, links: [] };
  let links: MetaLink[] = [];
  try {
    const parsed = JSON.parse(String(row.links_json ?? "[]"));
    if (Array.isArray(parsed)) links = parsed.flatMap((l) => {
      const url = safeUrl((l as Record<string, unknown>)?.url);
      return url ? [{ url, label: text((l as Record<string, unknown>)?.label, MAX_LINK_LABEL) }] : [];
    }).slice(0, MAX_LINKS);
  } catch { /* 壊れていれば空 */ }
  return { broadcaster: text(row.broadcaster, MAX_BROADCASTER), programName: text(row.program_name, MAX_EPISODE_TITLE), episodeTitle: text(row.episode_title, MAX_EPISODE_TITLE), links };
}

/** よく出るサイト: リンクの表示名と、そのサイトから分かる放送局。ドメイン(と、必要なら先頭のパス)で判定する。 */
type Site = { host: string; pathPrefix?: string; name: string; broadcaster: string };
export const SITES: Site[] = [
  { host: "web.nhk", name: "NHK ONE", broadcaster: "NHK" },
  { host: "txbiz.tv-tokyo.co.jp", pathPrefix: "/wbs", name: "WBS", broadcaster: "テレ東" },
];

export function siteOf(url: string): Site | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    return SITES.find((s) => s.host === host && (!s.pathPrefix || u.pathname === s.pathPrefix || u.pathname.startsWith(`${s.pathPrefix}/`))) ?? null;
  } catch {
    return null;
  }
}

/** 放送局を、リンクから自動で決める(編集していないときの既定)。最初に分かったサイトの放送局。 */
export function inferBroadcaster(urls: string[]): string {
  for (const url of urls) {
    const site = siteOf(url);
    if (site) return site.broadcaster;
  }
  return "";
}
