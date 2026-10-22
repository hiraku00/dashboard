import Link from "next/link";
import { PortalHeader } from "../../portal-nav";
import { BandLegend, BulletRows, Chip, DayAxis, DayBand, StackedBar } from "../../daily-report-ui";
import { DayTimeline } from "../../daily-report-day-view";
import { MarkdownRenderer } from "../../text-tube/markdown-renderer";
import { dayView, type DayView } from "@/app/lib/queries/daily-report";
import {
  axisRange,
  breakdown,
  formatMinutes,
  groupDayWorkItems,
  groupShares,
  timelineSegments,
  weekdayLabel,
} from "@/app/lib/daily-report-summary";
import { todoDate } from "@/app/lib/todo-date";

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}(${weekdayLabel(date)})`;
const longDate = (date: string) => `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日(${weekdayLabel(date)})`;

// Server Component: 1日分を D1 から直接読む(app/lib/queries/daily-report.ts)。クライアントになるのは
// 帯と表を連動させる DayTimeline と、原本の Markdown 描画だけ。
export default async function DailyReportDayPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  if (!isDate(date)) {
    return (
      <main className="portal-shell">
        <PortalHeader title="作業日報" active="/daily-report" />
        <section className="tube-panel dr-card"><p className="dr-empty">日付の形式が正しくありません(例: 2026-10-21)。</p></section>
      </main>
    );
  }
  let view: DayView | null = null;
  try {
    view = await dayView(date);
  } catch {
    view = null;
  }
  return (
    <main className="portal-shell">
      <PortalHeader title="作業日報" active="/daily-report" />
      {view ? <DayPage view={view} today={todoDate()} /> : <section className="tube-panel dr-card"><p className="dr-empty">日報を読み込めませんでした。時間をおいて開き直してください。</p></section>}
    </main>
  );
}

function DayPage({ view, today }: { view: DayView; today: string }) {
  const { date, report } = view;
  const active = Object.values(view.tagMinutes).reduce((sum, value) => sum + value, 0);
  const weekSegments = view.week.map((day) => timelineSegments(day.blocks));
  const weekAxis = axisRange(weekSegments.flat());
  const dayBlocks = view.week.find((day) => day.date === date)?.blocks ?? [];
  const groups = breakdown(view.tagMinutes, view.baseline ? view.baseline.minutes : null);
  const workGroups = groupDayWorkItems(view.workItems);

  return (
    <>
      <nav className="dr-daynav" aria-label="日付の移動">
        {view.prevDate ? <Link href={`/daily-report/${view.prevDate}`} prefetch={false}>‹ {shortDate(view.prevDate)}</Link> : <span />}
        <h2>{longDate(date)}</h2>
        {view.nextDate ? <Link href={`/daily-report/${view.nextDate}`} prefetch={false}>{shortDate(view.nextDate)} ›</Link> : <span />}
      </nav>

      <section className="tube-panel dr-card dr-week" aria-label="この週">
        <DayAxis axis={weekAxis} />
        {view.week.map((day, index) => {
          const selected = day.date === date;
          const future = day.date > today;
          const label = weekdayLabel(day.date);
          return (
            <div key={day.date} className={`dr-weekrow${selected ? " is-selected" : ""}${future ? " is-future" : ""}`}>
              {day.hasReport ? <Link href={`/daily-report/${day.date}`} prefetch={false} aria-current={selected ? "date" : undefined}>{label}</Link> : <span>{label}</span>}
              {day.hasReport ? <DayBand segments={weekSegments[index]} axis={weekAxis} height={14} /> : <div className="dr-band is-missing" style={{ height: 14 }}>{future ? "" : "日報なし"}</div>}
              <em>{day.hasReport ? formatMinutes(day.activeMinutes) : ""}</em>
            </div>
          );
        })}
        <BandLegend showMissing />
      </section>

      {!report ? (
        <section className="tube-panel dr-card"><p className="dr-empty">この日の日報はありません。{view.prevDate || view.nextDate ? "前後の日報へは上の矢印から移動できます。" : ""}</p></section>
      ) : (
        <>
          {report.parseStatus === "failed" && <p className="dr-banner is-warn" role="alert">この日の日報は解析できませんでした。集計には含めず、原本だけ表示します。</p>}

          <section className="tube-panel dr-card dr-facts" aria-label="この日の概要">
            <div className="dr-hero">
              <span>活動時間</span>
              <strong>{formatMinutes(active)}</strong>
            </div>
            <dl>
              <div><dt>記録</dt><dd>{report.recordStart && report.recordEnd ? `${report.recordStart}〜${report.recordEnd}` : "—"}{report.recordedMinutes !== null && ` (${formatMinutes(report.recordedMinutes)})`}</dd></div>
              <div><dt>ログなし</dt><dd>{formatMinutes(report.gapMinutes)}{report.recordedMinutes ? `(記録の${Math.round((report.gapMinutes / report.recordedMinutes) * 100)}%)` : ""}</dd></div>
              <div><dt>キャプチャ</dt><dd>{report.captureCount === null ? "—" : `${report.captureCount}回${report.captureCountIsMin ? "以上" : ""}`}</dd></div>
            </dl>
          </section>

          {dayBlocks.length > 0 && (
            <section className="tube-panel dr-card" aria-label="1日のタイムライン">
              <h3>1日のタイムライン</h3>
              <DayTimeline blocks={dayBlocks} />
            </section>
          )}

          {groups.length > 0 && (
            <section className="tube-panel dr-card" aria-label="この日の配分">
              <h3>この日の配分</h3>
              <StackedBar shares={groupShares(groups)} />
              <BulletRows groups={groups} baselineDays={view.baseline?.days ?? 0} />
            </section>
          )}

          {workGroups.length > 0 && (
            <section className="tube-panel dr-card" aria-label="メイン作業">
              <h3>メイン作業</h3>
              {workGroups.map((group) => (
                <div className="dr-work" key={group.categoryPosition}>
                  <h4>{group.category || "(見出しなし)"}</h4>
                  <ul>
                    {group.items.map((item) => (
                      <li key={item.position}>
                        {item.text}
                        {item.tags.length > 0 && <span className="dr-chips">{item.tags.map((tag) => <Chip key={tag} tag={tag} />)}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          )}

          {view.apps.length > 0 && (
            <section className="tube-panel dr-card" aria-label="アプリ使用状況">
              <h3>アプリ使用状況</h3>
              <table className="dr-table">
                <thead><tr><th scope="col">アプリ</th><th scope="col">回数</th><th scope="col">主な用途</th></tr></thead>
                <tbody>
                  {view.apps.map((app, index) => (
                    <tr key={index}>
                      <td>{app.appName}</td>
                      <td>{app.usageCount === null ? app.usageCountRaw || "—" : `${app.usageCount}${app.usageIsMin ? "+" : ""}`}</td>
                      <td>{app.purpose}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {view.notes.length > 0 && (
            <section className="tube-panel dr-card" aria-label="知見・メモ">
              <h3>知見・メモ</h3>
              <ul className="dr-notes">{view.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
            </section>
          )}

          {report.warnings.length > 0 && (
            <details className="tube-panel dr-card dr-details">
              <summary>解析時の警告({report.warnings.length}件)</summary>
              <ul>{report.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
            </details>
          )}

          <details className="tube-panel dr-card dr-details" open={report.parseStatus === "failed"}>
            <summary>原本を表示</summary>
            <div className="dr-raw"><MarkdownRenderer content={report.markdown} /></div>
          </details>
        </>
      )}
    </>
  );
}
