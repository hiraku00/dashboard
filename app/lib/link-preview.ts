/** ちきりんオプチャ詳細の放送情報フォームで、1つ目のリンクのページから 放送局・番組名・番組タイトル を読み取る、
 *  D1にも通信にも触れない純粋なロジック(vitestの "node" project でテストする)。取得は app/api/watch-list/link-preview。
 *
 *  NHK ONE(web.nhk)は og:title が「エピソード | 番組名」、テレ東BIZ(txbiz.tv-tokyo.co.jp)は <title> が「タイトル｜テレ東BIZ」で、
 *  番組名は dataLayer の 'program'(「Newsモーニングサテライト（モーサテ）」)に入っている。保存済みの項目の書き方
 *  (放送局「NHK」「テレ東」、番組名は括弧内の略称「モーサテ」「WBS」)に合わせる。知らないサイトは og:title だけ使う。 */
import { attribute, decodeHtml, tagContent } from "./html-meta.ts";
import { MAX_BROADCASTER, MAX_EPISODE_TITLE, inferBroadcaster, siteOf } from "./openchat-meta.ts";

export type LinkPreview = { creatorName: string; seriesTitle: string; title: string };

/** テレ東BIZの一部のページは属性値が二重にエスケープされている("M&amp;amp;A")ので、&amp; が残っていればもう一度戻す。 */
const unescapeHtml = (value: string) => { const once = decodeHtml(value); return once.includes("&amp;") ? decodeHtml(once) : once; };

const metaProperty = (html: string, property: string) =>
  unescapeHtml(tagContent(html, (tag) => attribute(tag, "property").toLowerCase() === property)).trim();

function pageTitle(html: string) {
  return unescapeHtml(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
}

/** 「Newsモーニングサテライト（モーサテ）」→「モーサテ」。括弧が無ければそのまま。 */
function shortProgramName(name: string) {
  return name.match(/[（(]([^（）()]+)[）)]\s*$/)?.[1]?.trim() || name.trim();
}

/** タイトルの末尾に付くサイト名・番組名(「 | 番組名」「｜テレ東BIZ」)を、右から1つずつ外す。 */
function stripSuffix(title: string, suffixes: string[]) {
  let result = title;
  for (const suffix of suffixes.filter(Boolean)) {
    const match = result.match(/^(.*?)\s*[|｜]\s*([^|｜]+)$/);
    if (match && match[2].trim() === suffix) result = match[1].trim();
  }
  return result;
}

/** NHK ONE のページの JSON-LD(partOfSeries.name)から番組名を読む。なければ ""。 */
function nhkSeriesName(html: string) {
  const raw = html.match(/"partOfSeries"\s*:\s*\{[^}]*?"name"\s*:\s*(?:\{\s*"@value"\s*:\s*)?"((?:\\.|[^"\\])*)"/)?.[1];
  if (!raw) return "";
  try { return String(JSON.parse(`"${raw}"`)).trim(); } catch { return ""; }
}

export function parseLinkPreview(html: string, url: string): LinkPreview {
  const ogTitle = metaProperty(html, "og:title") || pageTitle(html);
  const creatorName = inferBroadcaster([url]);
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* 不正なURLは呼び出し側で弾く */ }

  if (host === "web.nhk") {
    // og:title は、番組ページ(series-tep-…)では「エピソード | 番組名」、番組表のページ(schedule-tep-…)では
    // 「エピソード | 2026-09-29 NHK総合・東京」(日付と放送局)。番組名はどちらでも JSON-LD の partOfSeries にあるので、そちらを優先する。
    const match = ogTitle.match(/^(.*)\s*[|｜]\s*([^|｜]+)$/);
    const fromTitle = match && !/^\d{4}-\d{2}-\d{2}\b/.test(match[2].trim()) ? match[2].trim() : "";
    return { creatorName, seriesTitle: nhkSeriesName(html) || fromTitle, title: match ? match[1].trim() : ogTitle };
  }
  if (host === "txbiz.tv-tokyo.co.jp") {
    const program = html.match(/dataLayer\.push\(\{[^}]*'program'\s*:\s*'([^']*)'/)?.[1] ?? "";
    const seriesTitle = shortProgramName(decodeHtml(program));
    // 番組トップ(/wbs など)は番組名そのものがタイトルになるので、エピソードではないとして空にする。
    // タイトルの末尾は「｜テレ東BIZ」のほか、「｜ガイアの夜明け」のように番組名が付くページもある。
    const fullProgram = decodeHtml(program).trim();
    const title = stripSuffix(ogTitle, ["テレ東BIZ", fullProgram]);
    return { creatorName, seriesTitle, title: title === fullProgram ? "" : title };
  }
  const siteName = metaProperty(html, "og:site_name");
  return { creatorName, seriesTitle: "", title: stripSuffix(ogTitle, [siteName]) };
}

/** TVer のエピソードのURL(https://tver.jp/episodes/ept025uufz)から、エピソードIDを取り出す。違えば ""。 */
export function tverEpisodeId(url: string) {
  try {
    const u = new URL(url);
    if (u.hostname.replace(/^www\./, "") !== "tver.jp") return "";
    return u.pathname.match(/^\/episodes\/([a-z0-9]+)\/?$/i)?.[1] ?? "";
  } catch { return ""; }
}

/** TVer のページは中身をブラウザ側で描画するので、HTMLには番組情報が無い。代わりに公開JSON(statics.tver.jp/content/episode|series)を読む。
 *  放送局はエピソードの broadcastProviderLabel(「日テレ」「テレ朝」…)、タイトルは title。
 *  番組名は、ふだんはシリーズ名。ただし「日テレNEWS NNN」のようなニュースチャンネルは、番組ごとの切り抜きがまとめて入っていて
 *  シリーズ名が番組名にならないので、タイトル末尾の【バンキシャ！】を番組名にする。 */
export function parseTverPreview(episode: unknown, series: unknown): LinkPreview {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const e = (episode && typeof episode === "object" ? episode : {}) as Record<string, unknown>;
  const s = (series && typeof series === "object" ? series : {}) as Record<string, unknown>;
  const title = text(e.title);
  const seriesName = text(s.title);
  const bracket = title.match(/【([^【】]+)】\s*$/)?.[1]?.trim() ?? "";
  const digest = /NEWS|ニュース/i.test(seriesName);
  return { creatorName: text(e.broadcastProviderLabel), seriesTitle: digest && bracket ? bracket : seriesName, title };
}

/** 同期のときに放送情報を自動で入れてよいリンクか。サイトが分かっているもの(NHK ONE・テレ東BIZ)だけ。
 *  知らないサイトは og:title が番組名にならないことが多いので、手で入れてもらう(詳細画面の「リンクから取得」)。 */
export const canAutoFill = (url: string) => siteOf(url) !== null;

/** 取得したページの情報を、保存する放送情報(放送局・番組名・番組タイトル)にする。放送局はリンク(転送前のURL)からも決める。 */
export function autoFillFields(preview: LinkPreview, url: string) {
  return {
    broadcaster: (preview.creatorName || inferBroadcaster([url])).slice(0, MAX_BROADCASTER),
    programName: preview.seriesTitle.slice(0, MAX_EPISODE_TITLE),
    episodeTitle: preview.title.slice(0, MAX_EPISODE_TITLE),
  };
}

/** OCRが読み違えやすい文字と、本来の文字。 */
const OCR_MISREADS: Record<string, string> = { I: "1", O: "0", T: "7", l: "1" };
/** IDは大文字と数字だけ。小文字(OCRが「X」を「x」と読むなど)は、大文字に直した文字が本来の文字。 */
const misreadFix = (ch: string) => OCR_MISREADS[ch] ?? (/[a-z]/.test(ch) ? ch.toUpperCase() : undefined);

/** NHK ONE のURLの ID(series-tep-… と /ep/…。どちらも10文字)は、OCRが読み違えることがある。見つかっている型は2つ。
 *  - 「1」を「I」、「0」を「O」と読む(実例: VWRZ1WWNYP → VWRZIWWNYP で404)。
 *  - 「7」を「T」、「1」を小文字の「l」と読む(実例: PKQY1JGQ7V → PKQYIJGQTV。この例は「1→I」と同時に起きた)。
 *  - 大文字を小文字と読む(実例: 9N81M92LXV → 9N81M92LxV。「1→I」と同時に起きた)。
 *  - 縦線のノイズを「I」として1文字足す(実例: 6NMMPMNK5K → 6NMMPMINK5K の11文字で404)。
 *  読み違えかもしれない文字を直した候補のURLを、直す箇所の少ない順に返す(元のURLは含まない)。
 *  候補が多いときは当てずっぽうになるので出さない。NHK ONE 以外のURLも出さない。 */
export function nhkIdVariants(url: string): string[] {
  let u: URL;
  try { u = new URL(url); } catch { return []; }
  if (u.hostname.replace(/^www\./, "") !== "web.nhk") return [];
  const ids = [...u.pathname.matchAll(/(series-tep-|\/ep\/)([A-Za-z0-9]+)/g)].map((m) => ({ at: (m.index ?? 0) + m[1].length, id: m[2] }));
  // 1つのIDの候補(直す箇所の数, 直したID)。元のIDは直す箇所0。
  const candidatesOf = (id: string) => {
    const result: Array<{ changes: number; id: string }> = [{ changes: 0, id }];
    const swaps = [...id].flatMap((ch, i) => (misreadFix(ch) ? [i] : []));
    if (swaps.length <= 6) {
      for (let mask = 1; mask < 1 << swaps.length; mask++) {
        const chars = [...id];
        let changes = 0;
        swaps.forEach((at, i) => { if (mask & (1 << i)) { chars[at] = misreadFix(chars[at])!; changes++; } });
        result.push({ changes, id: chars.join("") });
      }
    }
    if (id.length === 11) {
      for (const at of [...id].flatMap((ch, i) => (ch === "I" || ch === "1" ? [i] : []))) result.push({ changes: 1, id: id.slice(0, at) + id.slice(at + 1) });
    }
    return result;
  };
  let combos: Array<{ changes: number; ids: string[] }> = [{ changes: 0, ids: [] }];
  for (const { id } of ids) {
    const options = candidatesOf(id);
    combos = combos.flatMap((c) => options.map((o) => ({ changes: c.changes + o.changes, ids: [...c.ids, o.id] }))).slice(0, 64);
  }
  const seen = new Set([url]);
  return combos
    .filter((c) => c.changes > 0 && c.changes <= 3)
    .sort((a, b) => a.changes - b.changes)
    .map((c) => {
      let path = u.pathname;
      // 後ろのIDから置き換える(前のIDの長さが変わっても位置がずれない)。
      for (let k = ids.length - 1; k >= 0; k--) path = path.slice(0, ids[k].at) + c.ids[k] + path.slice(ids[k].at + ids[k].id.length);
      return `${u.origin}${path}${u.search}`;
    })
    .filter((v) => !seen.has(v) && seen.add(v))
    .slice(0, 8);
}
