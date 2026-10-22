import Link from "next/link";
import {
  CATEGORY_LABELS,
  axisTicks,
  categoryOfTag,
  formatClock,
  formatMinutes,
  tagLabel,
  weekdayLabel,
  type AppSummary,
  type BreakdownCategory,
  type Category,
  type CategoryShare,
  type DayColumn,
  type Range,
  type TimeAxis,
  type TimelineSegment,
  type TrendPoint,
} from "./lib/daily-report-summary";

/** 作業日報の共通部品(docs/daily-report-view-design.md §5・§6)。色・模様・時間の表記は全タブでここに揃える。
 *  サーバー/クライアントのどちらからも使えるよう状態は持たず、操作はコールバックで受ける。 */

export const categoryColor = (category: Category) => `var(--c-${category})`;

export type ReportTab = "summary" | "time" | "work" | "notes" | "original";

/** 機能内タブ。サーバーのページ(URLの tab の検証)とクライアントのワークスペースの両方が使うので、ここに置く */
export const REPORT_TABS: [ReportTab, string][] = [
  ["summary", "概要"],
  ["time", "時間の使い方"],
  ["work", "作業内容"],
  ["notes", "知見・メモ"],
  ["original", "原本"],
];

export function reportHref(range: Range, date: string, tab: ReportTab): string {
  return `/daily-report?range=${range}&date=${date}${tab === "summary" ? "" : `&tab=${tab}`}`;
}

export const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}(${weekdayLabel(date)})`;

export function Chip({ tag }: { tag: string }) {
  return (
    <span className="dr-chip">
      <i aria-hidden="true" style={{ background: categoryColor(categoryOfTag(tag)) }} />
      {tagLabel(tag)}
    </span>
  );
}

/** カテゴリの凡例。割合を添えて直接ラベルを兼ねる。ログなしは模様で示す。 */
export function CategoryLegend({ shares, showGap = true, showMissing = false }: { shares: CategoryShare[]; showGap?: boolean; showMissing?: boolean }) {
  const order: Category[] = ["study", "dev", "life", "media", "other"];
  const byCategory = new Map(shares.map((share) => [share.category, share]));
  return (
    <ul className="dr-legend" aria-label="凡例">
      {order.map((category) => {
        const share = byCategory.get(category);
        if (category === "other" && !share) return null;
        return (
          <li key={category}>
            <i aria-hidden="true" style={{ background: categoryColor(category) }} />
            {CATEGORY_LABELS[category]}
            {share ? <b>{share.percent > 0 && share.percent < 1 ? "<1" : Math.round(share.percent)}%</b> : null}
          </li>
        );
      })}
      {showGap && <li><i aria-hidden="true" className="dr-hatch" />ログなし</li>}
      {showMissing && <li><i aria-hidden="true" className="dr-dash" />日報なし</li>}
    </ul>
  );
}

/** 時刻の目盛り。帯と同じ横軸(左端=axis.startHour)で、上下に並べたとき目盛りが揃う。 */
export function DayAxis({ axis }: { axis: TimeAxis }) {
  const span = axis.endHour - axis.startHour;
  return (
    <div className="dr-axis" aria-hidden="true">
      {axisTicks(axis).map((hour) => (
        <span key={hour} style={{ left: `${((hour - axis.startHour) / span) * 100}%` }}>{hour % 24}</span>
      ))}
    </div>
  );
}

function segmentTitle(segment: TimelineSegment) {
  const range = `${formatClock(segment.startMinute)}〜${formatClock(segment.endMinute)}`;
  const duration = segment.durationMinutes === null ? "" : ` ${formatMinutes(segment.durationMinutes)}`;
  if (segment.isGap) return `${range}${duration} ログなし`;
  const tags = segment.parts.map((part) => tagLabel(part.tag)).join("・");
  return `${range}${duration} ${segment.activity}\n${tags}${segment.parts.length > 1 ? "(複数のタグは等分)" : ""}`;
}

/** 1日の時間帯の帯。色=カテゴリ、斜線=ログなし。複数のタグが付いた時間帯は等分して塗る。 */
export function DayBand({
  segments,
  axis,
  height = 28,
  activePosition = null,
  onActive,
}: {
  segments: TimelineSegment[];
  axis: TimeAxis;
  height?: number;
  activePosition?: number | null;
  onActive?: (position: number | null) => void;
}) {
  const origin = axis.startHour * 60;
  const span = (axis.endHour - axis.startHour) * 60;
  return (
    <div className="dr-band" style={{ height }} onMouseLeave={onActive ? () => onActive(null) : undefined}>
      {segments.map((segment) => {
        const left = Math.max(0, ((segment.startMinute - origin) / span) * 100);
        const width = Math.max(0, ((Math.min(segment.endMinute, origin + span) - Math.max(segment.startMinute, origin)) / span) * 100);
        const classes = ["dr-seg", segment.isGap ? "is-gap" : "", activePosition === segment.position ? "is-active" : ""].filter(Boolean).join(" ");
        return (
          <div
            key={segment.position}
            className={classes}
            style={{ left: `calc(${left}% + 1px)`, width: `calc(${width}% - 2px)` }}
            title={segmentTitle(segment)}
            onMouseEnter={onActive ? () => onActive(segment.position) : undefined}
            onClick={onActive ? () => onActive(activePosition === segment.position ? null : segment.position) : undefined}
          >
            {segment.parts.map((part) => (
              <span key={part.tag} style={{ flex: part.fraction, background: categoryColor(part.category) }} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** カテゴリ別の割合の100%横棒(1本または今期・前期の2本を左端を揃えて)。分母は活動時間。 */
export function ShareBars({ rows }: { rows: { label: string; shares: CategoryShare[] }[] }) {
  return (
    <div className="dr-shares">
      {rows.map((row) => (
        <div className="dr-share-row" key={row.label}>
          <span>{row.label}</span>
          <div className="dr-share-bar" role="img" aria-label={`${row.label}: ${row.shares.map((share) => `${share.label} ${Math.round(share.percent)}%`).join("、")}`}>
            {row.shares.map((share) => (
              <span key={share.category} style={{ flex: share.minutes, background: categoryColor(share.category) }} title={`${share.label} ${Math.round(share.percent)}% ${formatMinutes(share.minutes)}`}>
                {share.percent >= 12 ? `${Math.round(share.percent)}%` : ""}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** カテゴリの見出しの下にタグを並べた横棒。縦線の目盛りが「比べる相手」。
 *  相手の日数が3日未満なら目盛りを点線にして参考扱いにし、0日なら出さない。 */
export function BulletRows({ categories, baselineDays, baselineLabel, valueLabel }: { categories: BreakdownCategory[]; baselineDays: number; baselineLabel: string; valueLabel: string }) {
  const max = Math.max(1, ...categories.flatMap((entry) => [entry.minutes, entry.baselineMinutes ?? 0, ...entry.tags.flatMap((tag) => [tag.minutes, tag.baselineMinutes ?? 0])]));
  const showTick = baselineDays > 0;
  const tentative = baselineDays > 0 && baselineDays < 3;
  const row = (key: string, label: string, minutes: number, baseline: number | null, color: string, isCategory: boolean) => (
    <div className={`dr-bullet-row${isCategory ? " is-category" : ""}`} key={key}>
      <span className="dr-bullet-label">{label}</span>
      <span className="dr-bullet-track">
        <span className="dr-bullet-bar" style={{ background: color, width: `${(minutes / max) * 100}%` }} />
        {showTick && baseline !== null && <span className={`dr-bullet-tick${tentative ? " is-tentative" : ""}`} style={{ left: `${(baseline / max) * 100}%` }} title={`${baselineLabel} ${formatMinutes(baseline)}`} />}
      </span>
      <span className="dr-bullet-value">{formatMinutes(minutes)}</span>
    </div>
  );
  return (
    <div className="dr-bullet">
      <div className="dr-bullet-row dr-bullet-head"><span /><span /><span>{valueLabel}</span></div>
      {categories.map((entry) => [
        row(`c-${entry.category}`, entry.label, entry.minutes, entry.baselineMinutes, categoryColor(entry.category), true),
        ...(entry.category === "other" ? [] : entry.tags.map((tag) => row(`t-${tag.tag}`, tag.label, tag.minutes, tag.baselineMinutes, categoryColor(entry.category), false))),
      ])}
      <p className="dr-note">
        {showTick ? <><i className="dr-tick" aria-hidden="true" />{baselineLabel}({baselineDays}日分{tentative ? "・参考" : ""})</> : `${baselineLabel}: 日報が無いため比較なし`}
      </p>
    </div>
  );
}

/** 日ごとの積み上げ縦棒(週次・月次)。押すとその日の日次へ。日報の無い日は破線の空き枠。 */
export function DayColumns({ columns, tab, today }: { columns: DayColumn[]; tab: ReportTab; today: string }) {
  const max = Math.max(60, ...columns.map((column) => column.total));
  return (
    <div className={`dr-columns${columns.length > 7 ? " is-dense" : ""}`} style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
      {columns.map((column) => {
        const label = columns.length > 7 ? String(Number(column.date.slice(8, 10))) : weekdayLabel(column.date);
        const weekend = ["土", "日"].includes(weekdayLabel(column.date));
        const body = (
          <>
            <span className="dr-col-value">{column.hasReport ? `${Math.round(column.total / 60)}h` : ""}</span>
            <span className={`dr-col-stack${column.hasReport ? "" : column.date > today ? " is-future" : " is-missing"}`}>
              {column.parts.map((part) => (
                <span key={part.category} style={{ height: `${(part.minutes / max) * 100}%`, background: categoryColor(part.category) }} />
              ))}
            </span>
            <span className={`dr-col-label${weekend ? " is-weekend" : ""}`}>{label}</span>
          </>
        );
        return column.hasReport ? (
          <Link key={column.date} className="dr-col" href={reportHref("day", column.date, tab === "summary" ? "summary" : tab)} prefetch={false} title={`${shortDate(column.date)} ${formatMinutes(column.total)}`}>{body}</Link>
        ) : (
          <div key={column.date} className="dr-col" title={`${shortDate(column.date)} 日報なし`}>{body}</div>
        );
      })}
    </div>
  );
}

/** 最近12期間の流れ。カテゴリごとの小さな折れ線を、縦軸を共通にして並べる(スモールマルチプル)。 */
export function TrendMultiples({ points }: { points: TrendPoint[] }) {
  const categories: Category[] = ["study", "dev", "life", "media"];
  const max = Math.max(60, ...points.flatMap((point) => categories.map((category) => point.minutes?.[category] ?? 0)));
  const width = 160;
  const height = 56;
  const x = (index: number) => 4 + (index / Math.max(1, points.length - 1)) * (width - 8);
  const y = (minutes: number) => height - 4 - (minutes / max) * (height - 8);
  return (
    <div className="dr-trends">
      {categories.map((category) => {
        const latest = points.at(-1)?.minutes?.[category];
        const segments: string[] = [];
        let current: string[] = [];
        points.forEach((point, index) => {
          if (!point.minutes) {
            if (current.length) segments.push(current.join(" "));
            current = [];
            return;
          }
          current.push(`${x(index).toFixed(1)},${y(point.minutes[category] ?? 0).toFixed(1)}`);
        });
        if (current.length) segments.push(current.join(" "));
        return (
          <figure key={category} className="dr-trend">
            <figcaption><i aria-hidden="true" style={{ background: categoryColor(category) }} />{CATEGORY_LABELS[category]}<b>{latest == null ? "—" : `${formatMinutes(latest)}/日`}</b></figcaption>
            <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${CATEGORY_LABELS[category]}の1日平均の推移: ${points.map((point) => `${point.label} ${point.minutes ? formatMinutes(point.minutes[category] ?? 0) : "日報なし"}`).join("、")}`}>
              <line x1="0" x2={width} y1={height - 4} y2={height - 4} className="dr-trend-base" />
              {segments.map((line, index) => <polyline key={index} points={line} fill="none" stroke={categoryColor(category)} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />)}
              {latest != null && <circle cx={x(points.length - 1)} cy={y(latest)} r="3.5" fill={categoryColor(category)} stroke="#fff" strokeWidth="2" />}
            </svg>
          </figure>
        );
      })}
      <p className="dr-note dr-trend-range">{points[0]?.label}〜{points.at(-1)?.label}・縦軸は4つ共通(最大 {formatMinutes(max)}/日)・途切れは日報の無い期間</p>
    </div>
  );
}

/** 時刻別の平均(1時間ごとの積み上げ縦棒)。縦軸は0〜60分で固定。 */
export function HourProfile({ hours, axis }: { hours: { hour: number; minutes: Partial<Record<Category, number>>; daysWithRecord: number }[]; axis: TimeAxis }) {
  const order: Category[] = ["study", "dev", "life", "media", "other"];
  return (
    <div className="dr-profile">
      <div className="dr-profile-bars" style={{ gridTemplateColumns: `repeat(${hours.length}, minmax(0, 1fr))` }}>
        {hours.map((slot) => (
          <div key={slot.hour} className="dr-profile-col" title={`${slot.hour}時台 ${order.filter((category) => slot.minutes[category]).map((category) => `${CATEGORY_LABELS[category]} ${Math.round(slot.minutes[category] ?? 0)}分`).join("・") || "記録なし"}(記録のあった日 ${slot.daysWithRecord}日)`}>
            <span className="dr-col-stack">
              {order.map((category) => (slot.minutes[category] ? <span key={category} style={{ height: `${((slot.minutes[category] ?? 0) / 60) * 100}%`, background: categoryColor(category) }} /> : null))}
            </span>
          </div>
        ))}
      </div>
      <DayAxis axis={axis} />
      <p className="dr-note">縦軸はその1時間の平均(0〜60分)。ログなしの時間は数えない。</p>
    </div>
  );
}

/** 曜日別の平均活動時間(月次)。 */
export function WeekdayBars({ weekdays }: { weekdays: { weekday: string; minutes: number | null; days: number }[] }) {
  const max = Math.max(60, ...weekdays.map((entry) => entry.minutes ?? 0));
  return (
    <div className="dr-bullet">
      {weekdays.map((entry) => (
        <div className="dr-bullet-row" key={entry.weekday}>
          <span className="dr-bullet-label">{entry.weekday}<small>{entry.days}日</small></span>
          <span className="dr-bullet-track"><span className="dr-bullet-bar is-neutral" style={{ width: `${((entry.minutes ?? 0) / max) * 100}%` }} /></span>
          <span className="dr-bullet-value">{entry.minutes === null ? "—" : formatMinutes(entry.minutes)}</span>
        </div>
      ))}
    </div>
  );
}

/** 週次のアプリ: アプリ×7日の点の行列(使った日を塗る)。 */
export function AppDots({ apps, dates }: { apps: AppSummary[]; dates: string[] }) {
  return (
    <table className="asset-table dr-app-dots">
      <thead>
        <tr><th scope="col">アプリ</th>{dates.map((date) => <th scope="col" key={date}>{weekdayLabel(date)}</th>)}<th scope="col">日数</th></tr>
      </thead>
      <tbody>
        {apps.map((app) => (
          <tr key={app.appKey}>
            <td>{app.name}</td>
            {dates.map((date) => <td key={date}><i className={app.dates.includes(date) ? "is-on" : ""} aria-label={app.dates.includes(date) ? "使用" : "なし"} /></td>)}
            <td>{app.dates.length}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 月次のアプリ: 使った日数の横棒。 */
export function AppBars({ apps }: { apps: AppSummary[] }) {
  const max = Math.max(1, ...apps.map((app) => app.dates.length));
  return (
    <div className="dr-bullet">
      {apps.map((app) => (
        <div className="dr-bullet-row" key={app.appKey}>
          <span className="dr-bullet-label">{app.name}</span>
          <span className="dr-bullet-track"><span className="dr-bullet-bar is-neutral" style={{ width: `${(app.dates.length / max) * 100}%` }} /></span>
          <span className="dr-bullet-value">{app.dates.length}日</span>
        </div>
      ))}
    </div>
  );
}
