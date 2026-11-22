/** 作業日報の6節目「予定と振り返り」の解析と、期間の集計。D1に触れない純粋なロジック(vitestの "node" project でテストする)。
 *
 *  6節目は auto-daily-report が Obsidian のモーニングページ(当日朝の予定と翌朝の振り返り)から書き足す節で、
 *  D1 には Markdown のまま daily_reports.reflection に入っている。表示のたびにここで表を読む(軽いので保存しない)。
 *  決まった形(auto-daily-report の templates/morning_prompt_template.md):
 *
 *    > モーニングページ: 当日朝（11/20）の予定・翌朝（11/21）の振り返り
 *    ### 予定と実績        | 予定 | 結果 | 状態 |   状態 = 済・一部・未・記録なし・予定外
 *    ### PCの外の活動      | 時刻 | 活動 | 種類 |   種類 = 食事・外出・買い物・運動・睡眠・連絡・その他
 *    ### 気になったこと・持ち越し   - [持ち越し] … / - [気がかり] …
 *
 *  表の形になる前に送った6節目(箇条書きだけ)は structured=false にして、画面は Markdown のまま出す。 */

export type PlanStatus = "done" | "partial" | "todo" | "unknown" | "extra";
export type ActivityKind = "meal" | "outing" | "exercise" | "sleep" | "contact" | "other";
export type NoteKind = "carryover" | "concern";

export type PlanRow = { plan: string; result: string; status: PlanStatus };
export type ActivityRow = { time: string | null; minute: number | null; activity: string; kind: ActivityKind };
export type ReflectionNote = { kind: NoteKind; text: string };

export type ParsedReflection = {
  /** 「当日朝（11/20）の予定・翌朝（11/21）の振り返り」(先頭の引用から「モーニングページ:」を除いたもの) */
  source: string | null;
  plans: PlanRow[];
  activities: ActivityRow[];
  notes: ReflectionNote[];
  /** 表か印付きの箇条書きを1つでも読めた。false なら Markdown のまま出す */
  structured: boolean;
};

export const PLAN_STATUSES: { status: PlanStatus; label: string }[] = [
  { status: "done", label: "済" },
  { status: "partial", label: "一部" },
  { status: "todo", label: "未" },
  { status: "unknown", label: "記録なし" },
  { status: "extra", label: "予定外" },
];

export const ACTIVITY_KINDS: { kind: ActivityKind; label: string }[] = [
  { kind: "meal", label: "食事" },
  { kind: "outing", label: "外出・買い物" },
  { kind: "exercise", label: "運動" },
  { kind: "sleep", label: "睡眠" },
  { kind: "contact", label: "連絡" },
  { kind: "other", label: "その他" },
];

export const NOTE_LABELS: Record<NoteKind, string> = { carryover: "持ち越し", concern: "気がかり" };

export const planStatusLabel = (status: PlanStatus) => PLAN_STATUSES.find((entry) => entry.status === status)!.label;
export const activityKindLabel = (kind: ActivityKind) => ACTIVITY_KINDS.find((entry) => entry.kind === kind)!.label;

function toStatus(raw: string): PlanStatus {
  const text = raw.replace(/\s+/g, "");
  if (/予定外/.test(text)) return "extra";
  if (/記録なし|不明/.test(text)) return "unknown";
  if (/一部|途中/.test(text)) return "partial";
  if (/^未|未着手|やらず|やっていない/.test(text)) return "todo";
  if (/済|完了|達成|done/i.test(text)) return "done";
  return "unknown";
}

function toKind(raw: string): ActivityKind {
  if (/食/.test(raw)) return "meal";
  if (/外出|買い物|買物/.test(raw)) return "outing";
  if (/運動|筋トレ|散歩/.test(raw)) return "exercise";
  if (/睡眠|就寝|起床/.test(raw)) return "sleep";
  if (/連絡/.test(raw)) return "contact";
  return "other";
}

function cleanCell(text: string): string {
  return text.replace(/\*\*/g, "").trim();
}

function readTable(lines: string[]): { columns: string[]; rows: string[][] } | null {
  const rows = lines
    .filter((line) => line.trim().startsWith("|"))
    .map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cleanCell))
    .filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));
  if (rows.length === 0) return null;
  const [columns, ...rest] = rows;
  return { columns, rows: rest.filter((cells) => cells.some(Boolean)) };
}

function column(columns: string[], pattern: RegExp, fallback: number): number {
  const index = columns.findIndex((name) => pattern.test(name));
  return index >= 0 ? index : fallback;
}

/** 「12:30頃」「9:05」→ 分。読めなければ null */
function clockMinute(text: string): number | null {
  const match = /(\d{1,2})\s*[:：]\s*(\d{2})/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 48 && minutes < 60 ? hours * 60 + minutes : null;
}

export function parseReflection(markdown: string): ParsedReflection {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const sourceLine = lines.find((line) => /^\s*>\s*モーニングページ\s*[:：]/.test(line));
  const source = sourceLine ? sourceLine.replace(/^\s*>\s*モーニングページ\s*[:：]\s*/, "").trim() || null : null;

  // `###` の小見出しで分ける(番号やかっこの付け方が揺れても、キーワードで見分ける)
  const sections = new Map<"plans" | "activities" | "notes", string[]>();
  let current: "plans" | "activities" | "notes" | null = null;
  for (const line of lines) {
    const heading = /^###(?!#)\s*(.*)$/.exec(line);
    if (heading) {
      const title = heading[1];
      current = /予定/.test(title) ? "plans" : /PC|活動/.test(title) ? "activities" : /持ち越し|気にな|気がかり/.test(title) ? "notes" : null;
      if (current && !sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current) sections.get(current)!.push(line);
  }

  const plans: PlanRow[] = [];
  const planTable = readTable(sections.get("plans") ?? []);
  if (planTable) {
    const planIndex = column(planTable.columns, /予定/, 0);
    const resultIndex = column(planTable.columns, /結果|実績/, 1);
    const statusIndex = column(planTable.columns, /状態/, 2);
    for (const cells of planTable.rows) {
      const plan = (cells[planIndex] ?? "").replace(/^[（(]予定(?:に)?な[しい][）)]\s*/, "");
      if (!plan) continue;
      plans.push({ plan, result: cells[resultIndex] ?? "", status: toStatus(cells[statusIndex] ?? "") });
    }
  }

  const activities: ActivityRow[] = [];
  const activityTable = readTable(sections.get("activities") ?? []);
  if (activityTable) {
    const timeIndex = column(activityTable.columns, /時刻|時間/, 0);
    const activityIndex = column(activityTable.columns, /活動|内容/, 1);
    const kindIndex = column(activityTable.columns, /種類/, 2);
    for (const cells of activityTable.rows) {
      const activity = cells[activityIndex] ?? "";
      if (!activity) continue;
      const time = cells[timeIndex] ?? "";
      activities.push({
        time: time && !/^[—―-]+$/.test(time) ? time : null,
        minute: clockMinute(time),
        activity,
        kind: toKind(cells[kindIndex] ?? ""),
      });
    }
  }

  const notes: ReflectionNote[] = [];
  for (const line of sections.get("notes") ?? []) {
    const match = /^\s*[-*・]\s+[[［]\s*(持ち越し|気がかり|気になる(?:こと)?)\s*[\]］]\s*(.+)$/.exec(line);
    if (match) notes.push({ kind: match[1] === "持ち越し" ? "carryover" : "concern", text: cleanCell(match[2]) });
  }

  return { source, plans, activities, notes, structured: plans.length > 0 || activities.length > 0 || notes.length > 0 };
}

export type StatusCounts = Record<PlanStatus, number>;

const emptyCounts = (): StatusCounts => ({ done: 0, partial: 0, todo: 0, unknown: 0, extra: 0 });

export function countStatuses(plans: PlanRow[]): StatusCounts {
  const counts = emptyCounts();
  for (const plan of plans) counts[plan.status] += 1;
  return counts;
}

/** 予定の件数(予定外を除く)と、そのうち済の割合(%)。予定が無ければ rate は null */
export function planRate(counts: StatusCounts): { planned: number; rate: number | null } {
  const planned = counts.done + counts.partial + counts.todo + counts.unknown;
  return { planned, rate: planned ? Math.round((counts.done / planned) * 100) : null };
}

export type ReflectionDay = { reportDate: string; parsed: ParsedReflection; markdown: string };

export type ReflectionSummary = {
  /** 6節目のある日(古い日から) */
  days: { reportDate: string; structured: boolean; counts: StatusCounts }[];
  totals: StatusCounts;
  planned: number;
  rate: number | null;
  activityCount: number;
  activityKinds: { kind: ActivityKind; count: number }[];
  /** 持ち越し・気がかり(新しい日から) */
  notes: (ReflectionNote & { reportDate: string })[];
  /** 表の形になっていない(Markdown のまま出す)日の数 */
  unstructuredDays: number;
};

export function summarizeReflections(items: { reportDate: string; markdown: string }[]): { days: ReflectionDay[]; summary: ReflectionSummary } {
  const days = [...items]
    .sort((a, b) => a.reportDate.localeCompare(b.reportDate))
    .map((item) => ({ reportDate: item.reportDate, markdown: item.markdown, parsed: parseReflection(item.markdown) }));
  const totals = emptyCounts();
  const kindCounts = new Map<ActivityKind, number>();
  let activityCount = 0;
  for (const day of days) {
    const counts = countStatuses(day.parsed.plans);
    for (const { status } of PLAN_STATUSES) totals[status] += counts[status];
    for (const activity of day.parsed.activities) kindCounts.set(activity.kind, (kindCounts.get(activity.kind) ?? 0) + 1);
    activityCount += day.parsed.activities.length;
  }
  const { planned, rate } = planRate(totals);
  return {
    days,
    summary: {
      days: days.map((day) => ({ reportDate: day.reportDate, structured: day.parsed.structured, counts: countStatuses(day.parsed.plans) })),
      totals,
      planned,
      rate,
      activityCount,
      activityKinds: ACTIVITY_KINDS.map(({ kind }) => ({ kind, count: kindCounts.get(kind) ?? 0 })).filter((entry) => entry.count > 0),
      notes: [...days].reverse().flatMap((day) => day.parsed.notes.map((note) => ({ ...note, reportDate: day.reportDate }))),
      unstructuredDays: days.filter((day) => !day.parsed.structured).length,
    },
  };
}
