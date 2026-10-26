"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { PortalHeader } from "./portal-nav";
import { ActivityChart, AllocationTable } from "./daily-report-charts";
import { NotesTable, TimePanel, WorkTable } from "./daily-report-tabs";
import { DayAxis, DayBand, WeekdayBars, REPORT_TABS, reportHref, shortDate, type ReportTab } from "./daily-report-ui";
import { DayTimeline } from "./daily-report-day-view";
import { DailyReportToolbar } from "./daily-report-toolbar";
import { MarkdownRenderer } from "./text-tube/markdown-renderer";
import { axisRange, formatMinutes, timelineSegments, type TimelineBlockInput } from "./lib/daily-report-summary";
import type { DailyReportModel } from "./lib/daily-report-model";

/** /daily-report のワークスペース(docs/daily-report-view-design.md §3・§4・§6)。Manage Asset と同じく、
 *  ヘッダーの下の機能内タブで切り口を替え、全タブを描いて `hidden` で隠す(切り替えは即時、URLは tab だけ書き換える)。
 *  期間(日次・週次・月次と日付)はツールバーのリンクで替え、サーバーが読み直す。 */

const PERIOD_NOUN = { day: "この日", week: "この週", month: "この月" } as const;

function Panel({ title, sub, children, actions }: { title: string; sub?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="asset-panel dr-panel">
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {sub ? <span>{sub}</span> : null}
        </div>
        {actions}
      </div>
      <div className="dr-panel-body">{children}</div>
    </section>
  );
}

export function DailyReportApp({ model, initialTab }: { model: DailyReportModel; initialTab: ReportTab }) {
  const [tab, setTab] = useState<ReportTab>(initialTab);
  const { period } = model;

  const selectTab = (next: ReportTab) => {
    setTab(next);
    // 期間はそのまま、tab だけURLに残す(再読み込み・共有で同じタブが開く)
    try {
      window.history.replaceState(null, "", reportHref(period.range, period.anchor, next));
    } catch {
      // history が使えない環境でも、タブの切り替え自体は動く
    }
  };

  const empty = (
    <section className="asset-panel dr-panel">
      <p className="dr-empty">
        {PERIOD_NOUN[period.range]}の日報はありません。
        {model.nav.prev ? <> <Link className="text-link" href={reportHref(period.range, model.nav.prev, tab)} prefetch={false}>前の日報のある{period.range === "day" ? "日" : period.range === "week" ? "週" : "月"}へ</Link></> : null}
        {model.nav.next ? <> <Link className="text-link" href={reportHref(period.range, model.nav.next, tab)} prefetch={false}>次へ</Link></> : null}
      </p>
    </section>
  );
  const hasReports = model.reportCount > 0;

  return (
    <main className="portal-shell asset-workspace daily-report-workspace">
      <PortalHeader title="作業日報" active="/daily-report">
        <nav className="asset-tabs" aria-label="作業日報 メニュー">
          {REPORT_TABS.map(([id, label]) => (
            <button key={id} type="button" className={tab === id ? "active" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => selectTab(id)}>
              {label}
            </button>
          ))}
        </nav>
      </PortalHeader>

      <DailyReportToolbar period={period} tab={tab} reportDates={model.reportDates} nav={model.nav} today={model.today} />

      <div hidden={tab !== "summary"}>{hasReports ? <SummaryTab model={model} /> : empty}</div>
      <div hidden={tab !== "time"}>{hasReports ? <TimeTab model={model} /> : empty}</div>
      <div hidden={tab !== "work"}>{hasReports ? <WorkTab model={model} /> : empty}</div>
      <div hidden={tab !== "notes"}>{hasReports ? <NotesTab model={model} /> : empty}</div>
      <div hidden={tab !== "original"}>{hasReports ? <OriginalTab model={model} /> : empty}</div>
    </main>
  );
}

function Hero({ model }: { model: DailyReportModel }) {
  return (
    <section className="asset-hero dr-hero">
      <div className="hero-grid">
        <div>
          <div className="dr-hero-figures">
            {model.hero.figures.map((figure) => (
              <div key={figure.label}>
                <p>{figure.label}</p>
                <strong>{figure.value}</strong>
              </div>
            ))}
          </div>
          {model.hero.caption ? <p>{model.hero.caption}</p> : null}
          {model.day?.report?.parseStatus === "partial" ? <p>一部を解析できなかった行があります(原本タブで確認)</p> : null}
          {model.day?.report?.parseStatus === "failed" ? <p>この日報は解析できませんでした(原本タブで確認)</p> : null}
        </div>
        {model.hero.items.map((item) => (
          <div className="hero-metric" key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            {item.sub ? <span className="hero-metric-sub">{item.sub}</span> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

/** 概要: ヒーロー＋2枚のパネル(左に活動時間、右に配分)。Manage Asset の資産概要と同じ並び(§4.1)。
 *  日次は活動時間の図を出さない(1日の時間は「時間帯」タブの帯で読む)。 */
function SummaryTab({ model }: { model: DailyReportModel }) {
  const { period } = model;
  const allocation = <AllocationTable rows={model.allocation} range={period.range} reportDays={model.reportCount} baseline={model.baseline} />;
  return (
    <>
      <Hero model={model} />
      {period.range === "day" ? (
        // 日次は左に1日の帯だけ(表は「時間帯」タブ)。週次・月次と同じ「左に時間、右に配分」の並びにする
        <div className="dr-overview">
          <section className="asset-panel dr-panel">
            <div className="panel-heading">
              <div>
                <h2>1日の時間帯</h2>
                <span>色は配分の表と同じ・斜線はログなし</span>
              </div>
            </div>
            <div className="dr-panel-body">
              {model.day && model.day.blocks.length ? <DayOverviewBand blocks={model.day.blocks} /> : <p className="dr-empty">時間帯の記録がありません。</p>}
            </div>
          </section>
          {allocation}
        </div>
      ) : (
        <div className="dr-overview">
          <ActivityChart days={model.activity.days} periods={model.activity.periods} periodsLabel={model.activity.periodsLabel} tab="summary" />
          {allocation}
        </div>
      )}
    </>
  );
}

function DayOverviewBand({ blocks }: { blocks: TimelineBlockInput[] }) {
  const segments = timelineSegments(blocks);
  const axis = axisRange(segments);
  return (
    <div className="dr-timeline">
      <DayAxis axis={axis} />
      <DayBand segments={segments} axis={axis} height={36} />
    </div>
  );
}

function TimeTab({ model }: { model: DailyReportModel }) {
  const { period } = model;
  if (period.range === "day") {
    return (
      <Panel title="1日の時間帯" sub="帯か表の行にポインタを重ねると、もう一方も強調されます">
        {model.day && model.day.blocks.length ? (
          <>
            <DayTimeline blocks={model.day.blocks} />
          </>
        ) : <p className="dr-empty">時間帯の記録がありません。</p>}
      </Panel>
    );
  }
  return (
    <div className="dr-stack">
      <TimePanel range={period.range} shares={model.legend} weekRows={model.weekRows} axis={model.weekAxis} profile={model.profile} reportCount={model.reportCount} />
      {period.range === "month" && (
        <Panel title="曜日別の平均活動時間" sub="日報のある日だけで平均">
          <WeekdayBars weekdays={model.weekdays} />
        </Panel>
      )}
    </div>
  );
}

function WorkTab({ model }: { model: DailyReportModel }) {
  if (!model.work.length) return <Panel title="作業内容"><p className="dr-empty">作業項目がありません。</p></Panel>;
  return <WorkTable rows={model.work} showDays={model.period.range !== "day"} tab="work" />;
}

function NotesTab({ model }: { model: DailyReportModel }) {
  if (!model.notes.length) return <Panel title="知見・メモ"><p className="dr-empty">知見・メモはありません。</p></Panel>;
  return <NotesTable notes={model.notes} showDate={model.period.range !== "day"} tab="notes" />;
}

function OriginalTab({ model }: { model: DailyReportModel }) {
  const { period } = model;
  if (period.range === "day") {
    if (!model.original) return <Panel title="原本"><p className="dr-empty">原本がありません。</p></Panel>;
    return (
      <>
        {model.original.warnings.length > 0 && (
          <section className="asset-panel dr-panel">
            <details className="dr-more">
              <summary>解析時の警告({model.original.warnings.length}件)</summary>
              <ul className="dr-notes">{model.original.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
            </details>
          </section>
        )}
        <Panel title="原本" sub="auto-daily-report が書いた Markdown">
          <div className="dr-raw"><MarkdownRenderer content={model.original.markdown} /></div>
        </Panel>
      </>
    );
  }
  // 週次・月次: 左にサマリ(auto-daily-report が週末・月末に作る)、右に日報の一覧
  const summaryTitle = period.range === "week" ? "週次サマリ" : "月次サマリ";
  return (
    <div className="dr-overview dr-original">
      {model.summary ? (
        <Panel title={summaryTitle} sub="auto-daily-report が書いた Markdown">
          <div className="dr-raw"><MarkdownRenderer content={model.summary.markdown} /></div>
        </Panel>
      ) : (
        <Panel title={summaryTitle}>
          <p className="dr-empty">{period.elapsedDays < period.days ? "期間が終わると作られます。" : "この期間のサマリはありません。"}</p>
        </Panel>
      )}
      <ReportList model={model} />
    </div>
  );
}

function ReportList({ model }: { model: DailyReportModel }) {
  return (
    <Panel title="日報の一覧" sub="押すとその日の原本へ">
      <div className="dr-table-scroll">
        <table className="asset-table">
          <thead><tr><th scope="col">日付</th><th scope="col" className="is-num">活動時間</th><th scope="col">記録</th><th scope="col" className="is-num">ログなし</th><th scope="col">解析</th></tr></thead>
          <tbody>
            {model.reportList.map((row) => (
              <tr key={row.date}>
                <th scope="row"><Link href={reportHref("day", row.date, "original")} prefetch={false}>{shortDate(row.date)}</Link></th>
                <td className="is-num">{formatMinutes(row.active)}</td>
                <td>{row.recordStart && row.recordEnd ? `${row.recordStart}〜${row.recordEnd}` : "—"}</td>
                <td className="is-num">{formatMinutes(row.gapMinutes)}</td>
                <td>{row.parseStatus === "ok" ? "正常" : row.parseStatus === "partial" ? "一部" : "失敗"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
