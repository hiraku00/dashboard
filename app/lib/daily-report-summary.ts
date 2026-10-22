/** 作業日報の表示用の集計(docs/daily-report-view-design.md §9.2)。D1には触れない純粋なロジック
 *  (vitestの "node" project でテストする)。取り込み時に計算済みの値(タグ×日の分数、時間帯の行)を、
 *  画面で読みやすい形に並べ替えるだけで、タグ付けや時間の数え方は daily-report-tags.ts が正。 */

import { DAILY_REPORT_TAGS, OTHER_TAG, type TagGroup } from "./daily-report-tags.ts";

export type DisplayGroup = TagGroup | "other";

/** 配分の並び順(色の割り当てもこの順。固定で、順位では変えない) */
export const GROUP_ORDER: DisplayGroup[] = ["study", "dev", "money", "life", "media", "other"];

export const GROUP_LABELS: Record<DisplayGroup, string> = {
  study: "学習",
  dev: "開発",
  money: "お金",
  life: "生活",
  media: "視聴",
  other: "その他",
};

const TAG_INDEX = new Map(DAILY_REPORT_TAGS.map((tag) => [tag.key, tag]));

export function groupOfTag(tag: string): DisplayGroup {
  return TAG_INDEX.get(tag)?.group ?? "other";
}

export function tagLabel(tag: string): string {
  if (tag === OTHER_TAG) return GROUP_LABELS.other;
  return TAG_INDEX.get(tag)?.label ?? tag;
}

/** 分数を `10h33m` / `54m` に。時間表記は画面全体でこの形に揃える。 */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}m`;
  return `${hours}h${String(rest).padStart(2, "0")}m`;
}

/** `HH:MM` を0時からの分に(`start_minute` と同じ単位)。 */
export function formatClock(minute: number): string {
  const wrapped = Math.max(0, Math.round(minute));
  return `${String(Math.floor(wrapped / 60) % 24).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

// ---- 日付(タイムゾーンは扱わず、report_date の文字列だけで計算する) ----

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** 0=月 … 6=日 */
export function weekdayIndex(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

export function weekdayLabel(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** その日を含む週(月曜始まり)の7日 */
export function weekDates(date: string): string[] {
  const monday = addDays(date, -weekdayIndex(date));
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

export type PeriodRange = {
  range: "week" | "month";
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  /** 期間の日数 */
  days: number;
  /** 期間のうち、today までに過ぎた日数(今週・今月が途中のときだけ days より小さい) */
  elapsedDays: number;
};

/** 週は `date` を含む月曜〜日曜、月は `date`(`YYYY-MM` か `YYYY-MM-DD`)の暦月。 */
export function periodRange(range: "week" | "month", date: string, today: string): PeriodRange {
  let from: string;
  let to: string;
  let prevFrom: string;
  let prevTo: string;
  if (range === "week") {
    from = addDays(date, -weekdayIndex(date));
    to = addDays(from, 6);
    prevFrom = addDays(from, -7);
    prevTo = addDays(from, -1);
  } else {
    const month = date.slice(0, 7);
    from = `${month}-01`;
    const next = new Date(`${from}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    to = addDays(next.toISOString().slice(0, 10), -1);
    prevTo = addDays(from, -1);
    prevFrom = `${prevTo.slice(0, 7)}-01`;
  }
  const days = daysBetween(from, to) + 1;
  const elapsedDays = today < from ? 0 : Math.min(days, daysBetween(from, today) + 1);
  return { range, from, to, prevFrom, prevTo, days, elapsedDays };
}

// ---- 時間帯の帯 ----

export type TimelineBlockInput = {
  position: number;
  startMinute: number | null;
  endMinute: number | null;
  activity: string;
  durationMinutes: number | null;
  isGap: boolean;
  /** その時間帯に付いたタグ(daily_report_item_tags の source='time') */
  tags: string[];
};

export type TimelinePart = { tag: string; group: DisplayGroup; fraction: number };

export type TimelineSegment = {
  position: number;
  startMinute: number;
  endMinute: number;
  activity: string;
  durationMinutes: number | null;
  isGap: boolean;
  /** 帯の塗り分け。複数のタグが付いた時間帯は、タグの数で等分する(時間の数え方と同じ規則) */
  parts: TimelinePart[];
};

/** 開始・終了が読めた時間帯だけを、帯に描く形にする。タグが無ければ other(灰)、ログなしは parts なし。 */
export function timelineSegments(blocks: TimelineBlockInput[]): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  for (const block of blocks) {
    if (block.startMinute === null || block.endMinute === null || block.endMinute <= block.startMinute) continue;
    const tags = block.isGap ? [] : block.tags.length ? block.tags : [OTHER_TAG];
    segments.push({
      position: block.position,
      startMinute: block.startMinute,
      endMinute: block.endMinute,
      activity: block.activity,
      durationMinutes: block.durationMinutes,
      isGap: block.isGap,
      parts: tags.map((tag) => ({ tag, group: groupOfTag(tag), fraction: 1 / tags.length })),
    });
  }
  return segments;
}

export type TimeAxis = { startHour: number; endHour: number };

const DEFAULT_AXIS: TimeAxis = { startHour: 8, endHour: 22 };

/** 帯の横軸。時間帯の最早開始〜最遅終了を時間単位に丸める。1つも無ければ既定(8〜22時)。 */
export function axisRange(segments: Pick<TimelineSegment, "startMinute" | "endMinute">[]): TimeAxis {
  if (!segments.length) return DEFAULT_AXIS;
  const start = Math.min(...segments.map((segment) => segment.startMinute));
  const end = Math.max(...segments.map((segment) => segment.endMinute));
  const startHour = Math.floor(start / 60);
  const endHour = Math.max(startHour + 1, Math.ceil(end / 60));
  return { startHour, endHour };
}

/** 帯の上の目盛り(時)。軸が短ければ1時間おき、長ければ2時間おき。 */
export function axisTicks(axis: TimeAxis): number[] {
  const step = axis.endHour - axis.startHour <= 9 ? 1 : 2;
  const first = Math.ceil(axis.startHour / step) * step;
  const ticks: number[] = [];
  for (let hour = first; hour <= axis.endHour; hour += step) ticks.push(hour);
  return ticks;
}

// ---- 配分(グループ→タグ) ----

export type BreakdownTag = { tag: string; label: string; minutes: number; baselineMinutes: number | null };
export type BreakdownGroup = {
  group: DisplayGroup;
  label: string;
  minutes: number;
  baselineMinutes: number | null;
  tags: BreakdownTag[];
};

/** タグ別の分数を、グループの見出しの下にタグを並べた形にする。グループもタグも分数の多い順で、
 *  other(その他)は最後。分数が0のタグは出さない。baseline(比べる相手)が無ければ目盛りは null。 */
export function breakdown(current: Record<string, number>, baseline: Record<string, number> | null): BreakdownGroup[] {
  const groups = new Map<DisplayGroup, BreakdownGroup>();
  for (const [tag, minutes] of Object.entries(current)) {
    if (minutes <= 0) continue;
    const group = groupOfTag(tag);
    let entry = groups.get(group);
    if (!entry) {
      entry = { group, label: GROUP_LABELS[group], minutes: 0, baselineMinutes: baseline ? 0 : null, tags: [] };
      groups.set(group, entry);
    }
    const baselineMinutes = baseline ? (baseline[tag] ?? 0) : null;
    entry.minutes += minutes;
    if (baselineMinutes !== null) entry.baselineMinutes = (entry.baselineMinutes ?? 0) + baselineMinutes;
    entry.tags.push({ tag, label: tagLabel(tag), minutes, baselineMinutes });
  }
  for (const entry of groups.values()) entry.tags.sort((a, b) => b.minutes - a.minutes);
  return [...groups.values()].sort((a, b) => {
    if (a.group === "other") return 1;
    if (b.group === "other") return -1;
    return b.minutes - a.minutes;
  });
}

/** 日ごとのタグ別の分数から、タグごとの「日報のある日の1日平均」を出す。日報のある日が0日なら null。 */
export function perDayAverages(rows: { reportDate: string; tag: string; minutes: number }[]): { days: number; minutes: Record<string, number> } | null {
  const dates = new Set(rows.map((row) => row.reportDate));
  if (!dates.size) return null;
  const minutes: Record<string, number> = {};
  for (const row of rows) minutes[row.tag] = (minutes[row.tag] ?? 0) + row.minutes;
  for (const tag of Object.keys(minutes)) minutes[tag] /= dates.size;
  return { days: dates.size, minutes };
}

/** グループ別の割合(100%横棒)。分母は活動時間(タグの合計)で、欠落は入れない。 */
export function groupShares(groups: Pick<BreakdownGroup, "group" | "label" | "minutes">[]): { group: DisplayGroup; label: string; minutes: number; percent: number }[] {
  const total = groups.reduce((sum, entry) => sum + entry.minutes, 0);
  return groups.map((entry) => ({ group: entry.group, label: entry.label, minutes: entry.minutes, percent: total ? (entry.minutes / total) * 100 : 0 }));
}

// ---- 作業項目 ----

export type WorkItemInput = { position: number; categoryPosition: number; category: string; itemPosition: number; text: string; tags: string[] };
export type WorkItemGroup = { categoryPosition: number; category: string; items: { position: number; text: string; tags: string[] }[] };

/** 1日分の作業項目を、`###` 見出しごとにまとめる(見出しの表記は日ごとに揺れるので名寄せはしない)。 */
export function groupDayWorkItems(items: WorkItemInput[]): WorkItemGroup[] {
  const groups = new Map<number, WorkItemGroup>();
  for (const item of [...items].sort((a, b) => a.categoryPosition - b.categoryPosition || a.itemPosition - b.itemPosition)) {
    let group = groups.get(item.categoryPosition);
    if (!group) {
      group = { categoryPosition: item.categoryPosition, category: item.category, items: [] };
      groups.set(item.categoryPosition, group);
    }
    group.items.push({ position: item.position, text: item.text, tags: item.tags });
  }
  return [...groups.values()];
}
