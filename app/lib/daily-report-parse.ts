/** 作業日報(auto-daily-report が生成する daily_report_YYYY-MM-DD.md)の解析。
 *  D1には触れない純粋なロジック(vitestの "node" project でテストする)。取り込み時に一度だけ呼び、
 *  結果をD1の正規化テーブルへ保存する(docs/daily-report-ingest-design.md)。
 *
 *  日報はLLMが書くので書式が揺れる。節は番号ではなく見出しのキーワードで、表の列は順番ではなく
 *  1行目の列名で見分ける。読めない行は飛ばして warnings に残し、例外で全体を落とさない。 */

/** パーサー・タグ辞書・アプリ名の別名表のどれかを変えたら上げる。古い版で解析された日報は再解析の対象になる。 */
export const PARSER_VERSION = 1;

export type ParseStatus = "ok" | "partial" | "failed";

export type DailyReportHeader = {
  /** 本文の `# 作業日報 YY-MM-DD` の日付(YYYY-MM-DD)。ファイル名の日付との照合用 */
  titleDate: string | null;
  recordStart: string | null;
  recordEnd: string | null;
  recordedMinutes: number | null;
  captureCount: number | null;
  /** 「N回以上」「N+回」のように下限値しか書かれていない */
  captureCountIsMin: boolean;
};

export type WorkItem = { position: number; categoryPosition: number; category: string; itemPosition: number; text: string };
export type AppUsage = { position: number; appName: string; appKey: string; usageCount: number | null; usageCountRaw: string; usageIsMin: boolean; purpose: string };
export type TimeBlock = { position: number; startMinute: number | null; endMinute: number | null; activity: string; durationMinutes: number | null; isGap: boolean };

export type ParsedDailyReport = {
  date: string;
  header: DailyReportHeader;
  workItems: WorkItem[];
  appUsage: AppUsage[];
  timeBlocks: TimeBlock[];
  notes: string[];
  /** 「ログなし」行の合計分 */
  gapMinutes: number;
  status: ParseStatus;
  warnings: string[];
};

type SectionKind = "work" | "apps" | "time" | "notes" | "files";

const SECTION_KEYWORDS: [SectionKind, RegExp][] = [
  ["work", /メイン作業/],
  ["apps", /アプリ/],
  ["time", /作業詳細/],
  ["notes", /知見/],
  ["files", /ファイル/],
];

/** 時間帯の表で「記録が無い」ことを表す行。「ログ確認」のような普通の作業内容に当たらないよう、語を限る。 */
const GAP_ACTIVITY = /ログなし|記録なし|記録欠落|データ欠落|ギャップ/;

/** `／` `/` などで分けた先頭を小文字・空白なしにしたものを、この表で寄せる。 */
const APP_KEY_ALIASES: Record<string, string> = {
  "claude.ai": "claude",
  claudecode: "claude-code",
  googlecalendar: "google-calendar",
  "googleカレンダー": "google-calendar",
  googlesheets: "google-sheets",
  "googleスプレッドシート": "google-sheets",
  googletranslate: "google-translate",
  "google翻訳": "google-translate",
  "googleフォト": "google-photos",
  "googleマップ": "google-maps",
  "ダッシュボード": "dashboard",
  "hiraku-watch-list": "dashboard",
  vscode: "vscode",
  visualstudiocode: "vscode",
  protonvpn: "proton-vpn",
  bingrewards: "bing-rewards",
};

export function parseDailyReport(markdown: string, date: string): ParsedDailyReport {
  const warnings: string[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");

  const sections = new Map<SectionKind, string[]>();
  let current: SectionKind | null = null;
  const preamble: string[] = [];
  for (const line of lines) {
    const heading = /^##(?!#)\s*(.*)$/.exec(line);
    if (heading) {
      const title = heading[1].replace(/^\d+\s*[.．]\s*/, "");
      current = SECTION_KEYWORDS.find(([, re]) => re.test(title))?.[0] ?? null;
      if (!current) warnings.push(`見出しを判別できません: ${line.trim()}`);
      else if (sections.has(current)) warnings.push(`同じ節が2回あります: ${line.trim()}`);
      else sections.set(current, []);
      continue;
    }
    if (current && sections.get(current)) sections.get(current)!.push(line);
    else if (!current && sections.size === 0) preamble.push(line);
  }

  const header = parseHeader(preamble.join("\n"), warnings);
  if (header.titleDate && header.titleDate !== date) warnings.push(`本文の日付(${header.titleDate})がファイルの日付(${date})と違います`);

  const workItems = sections.has("work") ? parseWorkItems(sections.get("work")!) : [];
  const appUsage = sections.has("apps") ? parseAppUsage(sections.get("apps")!, warnings) : [];
  const timeBlocks = sections.has("time") ? parseTimeBlocks(sections.get("time")!, warnings) : [];
  const notes = sections.has("notes") ? parseBullets(sections.get("notes")!) : [];
  for (const [kind, label] of [["work", "本日のメイン作業"], ["apps", "アプリ使用状況"], ["time", "作業詳細"], ["notes", "得られた知見・メモ"]] as const) {
    if (!sections.has(kind)) warnings.push(`「${label}」の節がありません`);
  }

  const gapMinutes = timeBlocks.filter((b) => b.isGap).reduce((sum, b) => sum + (b.durationMinutes ?? 0), 0);
  const headerRead = header.recordStart !== null || header.captureCount !== null;
  const status: ParseStatus = !headerRead && sections.size === 0 ? "failed" : warnings.length ? "partial" : "ok";
  return { date, header, workItems, appUsage, timeBlocks, notes, gapMinutes, status, warnings };
}

function parseHeader(text: string, warnings: string[]): DailyReportHeader {
  const header: DailyReportHeader = { titleDate: null, recordStart: null, recordEnd: null, recordedMinutes: null, captureCount: null, captureCountIsMin: false };

  const title = /作業日報\s+(\d{2}|\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (title) header.titleDate = `${title[1].length === 2 ? `20${title[1]}` : title[1]}-${title[2]}-${title[3]}`;

  const record = /記録期間\s*[:：]\s*(\d{1,2}:\d{2})(?::\d{2})?\s*[~～〜-]\s*(\d{1,2}:\d{2})(?::\d{2})?\s*(?:[（(]([^）)]*)[）)])?/.exec(text);
  if (record) {
    header.recordStart = padTime(record[1]);
    header.recordEnd = padTime(record[2]);
    header.recordedMinutes = (record[3] ? parseDuration(record[3]) : null) ?? spanMinutes(header.recordStart, header.recordEnd);
  } else warnings.push("記録期間を読めません");

  const capture = /キャプチャ回数\s*[:：]\s*(\d[\d,]*)\s*(\+)?\s*回?\s*(以上)?/.exec(text);
  if (capture) {
    header.captureCount = Number(capture[1].replaceAll(",", ""));
    header.captureCountIsMin = Boolean(capture[2] || capture[3]);
  } else warnings.push("キャプチャ回数を読めません");
  return header;
}

function parseWorkItems(lines: string[]): WorkItem[] {
  const items: WorkItem[] = [];
  let category = "";
  let categoryPosition = -1;
  let itemPosition = 0;
  for (const line of lines) {
    const heading = /^###\s*(.*)$/.exec(line);
    if (heading) {
      category = stripMarkup(heading[1].replace(/^\d+\s*[.．]\s*/, ""));
      categoryPosition += 1;
      itemPosition = 0;
      continue;
    }
    const bullet = bulletText(line);
    if (bullet === null) continue;
    // 見出しより前の箇条書きは、名前の無い1つの分類として扱う
    if (categoryPosition < 0) categoryPosition = 0;
    items.push({ position: items.length, categoryPosition, category, itemPosition, text: bullet });
    itemPosition += 1;
  }
  return items;
}

function parseAppUsage(lines: string[], warnings: string[]): AppUsage[] {
  const table = readTable(lines);
  if (!table) {
    warnings.push("アプリ使用状況の表がありません");
    return [];
  }
  const nameCol = columnIndex(table.columns, /アプリ|ツール|ブラウザ/, 0);
  const countCol = columnIndex(table.columns, /回数/, 1);
  const purposeCol = columnIndex(table.columns, /用途/, 2);
  return table.rows.map((cells, position) => {
    const appName = stripMarkup(cells[nameCol] ?? "");
    const usageCountRaw = stripMarkup(cells[countCol] ?? "");
    // 「多い」「-」「約2時間」のように回数でない値も書かれる。数値にできなければnullにして原文を残すだけで、警告にはしない
    const { count, isMin } = parseUsageCount(usageCountRaw);
    return { position, appName, appKey: appKey(appName), usageCount: count, usageCountRaw, usageIsMin: isMin, purpose: stripMarkup(cells[purposeCol] ?? "") };
  });
}

function parseTimeBlocks(lines: string[], warnings: string[]): TimeBlock[] {
  const table = readTable(lines);
  if (!table) {
    warnings.push("作業詳細の表がありません");
    return [];
  }
  const timeCol = columnIndex(table.columns, /時間帯|時刻/, 0);
  const activityCol = columnIndex(table.columns, /内容/, 1);
  const durationCol = columnIndex(table.columns, /所要/, 2);
  return table.rows.map((cells, position) => {
    const timeRaw = stripMarkup(cells[timeCol] ?? "");
    const activity = stripMarkup(cells[activityCol] ?? "");
    const range = /(\d{1,2}:\d{2})(?::\d{2})?\s*(?:[~～〜-]\s*(\d{1,2}:\d{2})(?::\d{2})?)?/.exec(timeRaw);
    const start = range ? toMinute(range[1]) : null;
    let end = range?.[2] ? toMinute(range[2]) : null;
    if (start !== null && end !== null && end < start) end += 24 * 60;   // 日付をまたぐ
    if (start === null) warnings.push(`時間帯を読めません: ${timeRaw}`);
    const span = start !== null && end !== null ? end - start : null;
    const durationMinutes = parseDuration(stripMarkup(cells[durationCol] ?? "")) ?? span;
    return { position, startMinute: start, endMinute: end, activity, durationMinutes, isGap: GAP_ACTIVITY.test(activity) };
  });
}

function parseBullets(lines: string[]): string[] {
  return lines.map(bulletText).filter((text): text is string => text !== null);
}

/** 箇条書きの1行なら本文、そうでなければnull。入れ子の箇条書きも1件として扱う。 */
function bulletText(line: string): string | null {
  const match = /^\s*[-*・]\s+(.*)$/.exec(line);
  if (!match) return null;
  const text = stripMarkup(match[1]);
  return text || null;
}

function readTable(lines: string[]): { columns: string[]; rows: string[][] } | null {
  const rows = lines.filter((line) => line.trim().startsWith("|")).map(splitRow);
  const body = rows.filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));
  if (body.length === 0) return null;
  const [columns, ...rest] = body;
  return { columns, rows: rest.filter((cells) => cells.some(Boolean)) };
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function columnIndex(columns: string[], pattern: RegExp, fallback: number): number {
  const index = columns.findIndex((column) => pattern.test(column));
  return index >= 0 ? index : fallback;
}

/** 「300+」「602（記録上のアプリ名）」「約20回」「150回以上」「非常に多い（100回以上）」。
 *  「約30分」のような時間や、「2025年…」のような日付は回数ではないのでnull。 */
export function parseUsageCount(raw: string): { count: number | null; isMin: boolean } {
  const text = raw.trim();
  if (/\d\s*(分|時間)/.test(text)) return { count: null, isMin: false };
  const leading = /^約?\s*(\d[\d,]*)(?![\d,]*\s*[年月日/.])\s*(\+|回以上)?/.exec(text);
  if (leading) return { count: Number(leading[1].replaceAll(",", "")), isMin: Boolean(leading[2]) };
  const inner = /[（(](\d[\d,]*)\s*(\+|回以上)?[^）)]*[）)]/.exec(text);
  if (inner) return { count: Number(inner[1].replaceAll(",", "")), isMin: Boolean(inner[2]) };
  return { count: null, isMin: false };
}

/** 表のアプリ名から集計用のキーを作る(「Claude Code／ros2_ws」→ claude-code、「Gemini・Anki」→ gemini)。 */
export function appKey(appName: string): string {
  const first = appName.split(/[／/・＋+、,]/)[0].replace(/[（(].*$/, "").toLowerCase().replace(/\s+/g, "");
  return APP_KEY_ALIASES[first] ?? first;
}

/** 「1時間30分」「45分」「約2時間」「約 1.5 時間」「30分[2]」→ 分。読めなければnull。 */
export function parseDuration(raw: string): number | null {
  const text = raw.replace(/\s+/g, "");
  const match = /(\d+(?:\.\d+)?)時間(?:(\d+)分)?/.exec(text) ?? /()(\d+)分/.exec(text);
  if (!match) return null;
  return Math.round(Number(match[1] || 0) * 60 + Number(match[2] ?? 0));
}

function toMinute(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function padTime(value: string): string {
  const [hours, minutes] = value.split(":");
  return `${hours.padStart(2, "0")}:${minutes}`;
}

function spanMinutes(start: string, end: string): number {
  const span = toMinute(end) - toMinute(start);
  return span < 0 ? span + 24 * 60 : span;
}

/** 強調(**)と、末尾の脚注番号([1])を除く。 */
function stripMarkup(text: string): string {
  return text.replace(/\*\*/g, "").replace(/(?:\[\d+\])+$/, "").trim();
}
