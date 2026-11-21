import Link from "next/link";
import type { ReactNode } from "react";
import { MarkdownRenderer } from "./text-tube/markdown-renderer";
import { reportHref, shortDate } from "./daily-report-ui";
import {
  ACTIVITY_KINDS,
  NOTE_LABELS,
  PLAN_STATUSES,
  activityKindLabel,
  countStatuses,
  planRate,
  planStatusLabel,
  type ActivityKind,
  type PlanStatus,
  type ReflectionDay,
  type ReflectionNote,
  type ReflectionSummary,
  type StatusCounts,
} from "./lib/daily-report-reflection";

/** 振り返りタブ(docs/daily-report-view-design.md §4.7)。日報の6節目「予定と振り返り」の表を、
 *  原本の Markdown とは別の形(予定の達成・PCの外の活動の時刻順・持ち越し、期間では日ごとの達成と種類別の数)で見せる。
 *  表の形になる前に送った6節目は、Markdown のまま出す。 */

const SOURCE = "モーニングページの当日朝の予定と翌朝の振り返りから";

function Panel({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="asset-panel dr-panel">
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {sub ? <span>{sub}</span> : null}
        </div>
      </div>
      <div className="dr-panel-body">{children}</div>
    </section>
  );
}

function StatusBadge({ status }: { status: PlanStatus }) {
  return <span className={`dr-rf-badge is-${status}`}>{planStatusLabel(status)}</span>;
}

/** 状態の内訳の積み上げ棒。max を渡すと、その件数を全幅にして日どうしの長さを比べられるようにする */
function StatusBar({ counts, max }: { counts: StatusCounts; max?: number }) {
  const total = PLAN_STATUSES.reduce((sum, { status }) => sum + counts[status], 0);
  const scale = max ?? total;
  if (!scale) return <div className="dr-rf-bar is-empty" />;
  return (
    <div className="dr-rf-bar" role="img" aria-label={PLAN_STATUSES.filter(({ status }) => counts[status]).map(({ status, label }) => `${label}${counts[status]}件`).join("、")}>
      {PLAN_STATUSES.map(({ status }) => (counts[status] ? <i key={status} className={`is-${status}`} style={{ width: `${(counts[status] / scale) * 100}%` }} /> : null))}
    </div>
  );
}

function StatusLegend({ counts }: { counts?: StatusCounts }) {
  return (
    <ul className="dr-rf-legend">
      {PLAN_STATUSES.filter(({ status }) => !counts || counts[status]).map(({ status, label }) => (
        <li key={status}><i className={`is-${status}`} />{label}{counts ? ` ${counts[status]}` : ""}</li>
      ))}
    </ul>
  );
}

function RateFigure({ counts }: { counts: StatusCounts }) {
  const { planned, rate } = planRate(counts);
  return (
    <div className="dr-rf-figure">
      <p>予定の達成</p>
      {planned ? (
        <>
          <strong>{counts.done}<small>/{planned}件 済</small></strong>
          <span>{`${rate}%`}{counts.partial ? `・一部 ${counts.partial}件` : ""}{counts.extra ? `・予定外 ${counts.extra}件` : ""}</span>
          {/* 予定外は達成の分母に入らないので、棒からも外す */}
          <StatusBar counts={{ ...counts, extra: 0 }} />
        </>
      ) : (
        <><strong>—</strong><span>予定の記録なし</span></>
      )}
    </div>
  );
}

function CountFigure({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="dr-rf-figure">
      <p>{label}</p>
      <strong>{value}<small>件</small></strong>
      {sub ? <span>{sub}</span> : null}
    </div>
  );
}

function NoteList({ notes }: { notes: ReflectionNote[] }) {
  if (!notes.length) return <p className="dr-empty">持ち越し・気がかりはありません。</p>;
  const groups = (["carryover", "concern"] as const)
    .map((kind) => ({ kind, items: notes.filter((note) => note.kind === kind) }))
    .filter((group) => group.items.length);
  return (
    <div className="dr-rf-notes">
      {groups.map((group) => (
        <div key={group.kind}>
          <h3>{NOTE_LABELS[group.kind]}</h3>
          <ul>{group.items.map((note, index) => <li key={index}>{note.text}</li>)}</ul>
        </div>
      ))}
    </div>
  );
}

function KindDot({ kind }: { kind: ActivityKind }) {
  return <i className={`dr-rf-dot is-${kind}`} aria-hidden="true" />;
}

/** 日次: 上に数字、その下に予定と実績の表、PCの外の活動(時刻順)と持ち越し・気がかり */
export function ReflectionDayView({ day }: { day: ReflectionDay | undefined }) {
  if (!day) {
    return (
      <Panel title="予定と振り返り">
        <p className="dr-empty">この日の予定と振り返りはありません。モーニングページから書き足した日だけ表示します。</p>
      </Panel>
    );
  }
  const { parsed } = day;
  if (!parsed.structured) {
    // 表の形になる前に送った6節目
    return (
      <Panel title="予定と振り返り" sub={SOURCE}>
        <div className="dr-raw"><MarkdownRenderer content={day.markdown} /></div>
      </Panel>
    );
  }
  const counts = countStatuses(parsed.plans);
  const carryovers = parsed.notes.filter((note) => note.kind === "carryover").length;
  // 時刻の早い順に書かせているので、書かれた順のまま出す(時刻の無い行も前後の流れの中に置ける)
  const activities = parsed.activities;
  return (
    <div className="dr-stack">
      <section className="asset-panel dr-panel">
        <div className="dr-rf-figures">
          <RateFigure counts={counts} />
          <CountFigure label="PCの外の活動" value={parsed.activities.length} />
          <CountFigure label="持ち越し" value={carryovers} sub={`気がかり ${parsed.notes.length - carryovers}件`} />
        </div>
        {parsed.source ? <p className="dr-rf-source">モーニングページ: {parsed.source}</p> : null}
      </section>

      <Panel title="予定と実績" sub="予定は当日朝のモーニングページ、結果は日報と翌朝の振り返りから">
        {parsed.plans.length ? (
          <div className="dr-table-scroll">
            <table className="asset-table dr-rf-plans">
              <thead><tr><th scope="col">状態</th><th scope="col">予定</th><th scope="col">結果</th></tr></thead>
              <tbody>
                {parsed.plans.map((row, index) => (
                  <tr key={index} className={row.status === "extra" ? "is-extra" : undefined}>
                    <td><StatusBadge status={row.status} /></td>
                    <td className="dr-rf-plan">{row.plan}</td>
                    <td>{row.result}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="dr-empty">予定の記録はありません。</p>}
      </Panel>

      <div className="dr-overview dr-original">
        <Panel title="PCの外の活動" sub="翌朝の振り返りから。時刻は話した内容なので目安">
          {activities.length ? (
            <ol className="dr-rf-timeline">
              {activities.map((row, index) => (
                <li key={index}>
                  <time>{row.time ?? "—"}</time>
                  <KindDot kind={row.kind} />
                  <div>
                    <p>{row.activity}</p>
                    <small>{activityKindLabel(row.kind)}</small>
                  </div>
                </li>
              ))}
            </ol>
          ) : <p className="dr-empty">PCの外の活動の記録はありません。</p>}
        </Panel>
        <Panel title="持ち越し・気がかり">
          <NoteList notes={parsed.notes} />
        </Panel>
      </div>
    </div>
  );
}

/** 週次・月次: 期間の数字、日ごとの予定の達成(積み上げ棒)、持ち越し・気がかりの表、PCの外の活動の種類別の数 */
export function ReflectionPeriodView({ summary, reportCount, noun }: { summary: ReflectionSummary; reportCount: number; noun: string }) {
  if (!summary.days.length) {
    return (
      <Panel title="予定と振り返り">
        <p className="dr-empty">{noun}の予定と振り返りはありません。モーニングページから書き足した日だけ表示します。</p>
      </Panel>
    );
  }
  const carryovers = summary.notes.filter((note) => note.kind === "carryover").length;
  const maxPerDay = Math.max(1, ...summary.days.map((day) => PLAN_STATUSES.reduce((sum, { status }) => sum + day.counts[status], 0)));
  const maxKind = Math.max(1, ...summary.activityKinds.map((entry) => entry.count));
  return (
    <div className="dr-stack">
      <section className="asset-panel dr-panel">
        <div className="dr-rf-figures">
          <RateFigure counts={summary.totals} />
          <CountFigure label="PCの外の活動" value={summary.activityCount} />
          <CountFigure label="持ち越し" value={carryovers} sub={`気がかり ${summary.notes.length - carryovers}件`} />
        </div>
        <p className="dr-rf-source">
          {`${reportCount}日の日報のうち${summary.days.length}日分(${SOURCE})`}
          {summary.unstructuredDays ? `。うち${summary.unstructuredDays}日は表の形になる前の書き方なので、集計に入っていません` : ""}
        </p>
      </section>

      <Panel title="日ごとの予定の達成" sub="棒の長さは予定(予定外を含む)の件数。日付を押すとその日の振り返りへ">
        <StatusLegend />
        <ul className="dr-rf-days">
          {summary.days.map((day) => {
            const { planned } = planRate(day.counts);
            return (
              <li key={day.reportDate}>
                <Link href={reportHref("day", day.reportDate, "reflection")} prefetch={false}>{shortDate(day.reportDate)}</Link>
                {day.structured ? <StatusBar counts={day.counts} max={maxPerDay} /> : <div className="dr-rf-bar is-empty" />}
                <span>{!day.structured ? "表なし" : planned ? `済 ${day.counts.done}/${planned}` : "予定なし"}</span>
              </li>
            );
          })}
        </ul>
      </Panel>

      <div className="dr-overview dr-original">
        <Panel title="持ち越し・気がかり" sub="新しい日から">
          {summary.notes.length ? (
            <div className="dr-table-scroll">
              <table className="asset-table dr-notes-table">
                <thead><tr><th scope="col">日付</th><th scope="col">種類</th><th scope="col">内容</th></tr></thead>
                <tbody>
                  {summary.notes.map((note, index) => {
                    const firstOfDay = index === 0 || summary.notes[index - 1].reportDate !== note.reportDate;
                    return (
                      <tr key={`${note.reportDate}-${index}`} className={firstOfDay && index > 0 ? "is-new-day" : undefined}>
                        <th scope="row">{firstOfDay ? <Link href={reportHref("day", note.reportDate, "reflection")} prefetch={false}>{shortDate(note.reportDate)}</Link> : null}</th>
                        <td><span className={`dr-rf-note-kind is-${note.kind}`}>{NOTE_LABELS[note.kind]}</span></td>
                        <td className="dr-note-text">{note.text}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <p className="dr-empty">持ち越し・気がかりはありません。</p>}
        </Panel>
        <Panel title="PCの外の活動" sub="種類別の件数">
          {summary.activityKinds.length ? (
            <ul className="dr-rf-kinds">
              {ACTIVITY_KINDS.map(({ kind, label }) => {
                const count = summary.activityKinds.find((entry) => entry.kind === kind)?.count ?? 0;
                if (!count) return null;
                return (
                  <li key={kind}>
                    <span><KindDot kind={kind} />{label}</span>
                    <div className="dr-rf-kind-track"><i className={`is-${kind}`} style={{ width: `${(count / maxKind) * 100}%` }} /></div>
                    <b>{count}</b>
                  </li>
                );
              })}
            </ul>
          ) : <p className="dr-empty">PCの外の活動の記録はありません。</p>}
        </Panel>
      </div>
    </div>
  );
}
