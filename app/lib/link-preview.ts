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
