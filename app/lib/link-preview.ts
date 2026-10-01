/** ちきりんオプチャ詳細の放送情報フォームで、1つ目のリンクのページから 放送局・番組名・番組タイトル を読み取る、
 *  D1にも通信にも触れない純粋なロジック(vitestの "node" project でテストする)。取得は app/api/watch-list/link-preview。
 *
 *  NHK ONE(web.nhk)は og:title が「エピソード | 番組名」、テレ東BIZ(txbiz.tv-tokyo.co.jp)は <title> が「タイトル｜テレ東BIZ」で、
 *  番組名は dataLayer の 'program'(「Newsモーニングサテライト（モーサテ）」)に入っている。保存済みの項目の書き方
 *  (放送局「NHK」「テレ東」、番組名は括弧内の略称「モーサテ」「WBS」)に合わせる。知らないサイトは og:title だけ使う。 */
import { attribute, decodeHtml, tagContent } from "./html-meta.ts";
import { inferBroadcaster } from "./openchat-meta.ts";

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

export function parseLinkPreview(html: string, url: string): LinkPreview {
  const ogTitle = metaProperty(html, "og:title") || pageTitle(html);
  const creatorName = inferBroadcaster([url]);
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* 不正なURLは呼び出し側で弾く */ }

  if (host === "web.nhk") {
    // og:title は「エピソード | 番組名」。番組名にも「|」は無いので、最後の「|」で分ける。
    const match = ogTitle.match(/^(.*)\s*[|｜]\s*([^|｜]+)$/);
    return match ? { creatorName, seriesTitle: match[2].trim(), title: match[1].trim() } : { creatorName, seriesTitle: "", title: ogTitle };
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
