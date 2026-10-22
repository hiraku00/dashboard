"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { reportHref, type ReportTab } from "./daily-report-ui";
import { RANGES, addDays, addMonths, weekdayIndex, weekdayLabel, type PeriodRange, type Range } from "./lib/daily-report-summary";

/** ツールバー: 単位のプルダウン・前後の移動・日付(カレンダー)・今日へ(docs/daily-report-view-design.md §3)。
 *  期間はURLで持つのでリンクで移動し、サーバーが読み直す。タブは保ったまま移動する。 */

const ymd = (date: string) => date.replaceAll("-", "/");

function periodLabel(period: PeriodRange) {
  if (period.range === "day") return `${ymd(period.from)}(${weekdayLabel(period.from)})`;
  if (period.range === "week") return `${ymd(period.from)}(月)〜${Number(period.to.slice(5, 7))}/${Number(period.to.slice(8, 10))}(日)`;
  return `${Number(period.from.slice(0, 4))}年${Number(period.from.slice(5, 7))}月`;
}

const CURRENT_LABEL: Record<Range, string> = { day: "最新の日へ", week: "今週へ", month: "今月へ" };
const STEP_LABEL: Record<Range, string> = { day: "日報", week: "週", month: "月" };

export function DailyReportToolbar({
  period,
  tab,
  reportDates,
  nav,
  today,
}: {
  period: PeriodRange;
  tab: ReportTab;
  reportDates: string[];
  nav: { prev: string | null; next: string | null; current: string; switchTo: Record<Range, string> };
  today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const onClick = (event: MouseEvent) => { if (box.current && !box.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const arrow = (target: string | null, direction: "prev" | "next") => {
    const label = `${direction === "prev" ? "前" : "次"}の${STEP_LABEL[period.range]}`;
    return target ? (
      <Link className="dr-step" href={reportHref(period.range, target, tab)} prefetch={false} aria-label={label} title={label}>{direction === "prev" ? "‹" : "›"}</Link>
    ) : (
      <span className="dr-step is-disabled" aria-label={`${label}はありません`}>{direction === "prev" ? "‹" : "›"}</span>
    );
  };

  return (
    <div className="page-toolbar dr-toolbar">
      <label className="dr-range">
        <span className="sr-only">期間の単位</span>
        <select value={period.range} onChange={(event) => router.push(reportHref(event.target.value as Range, nav.switchTo[event.target.value as Range], tab))}>
          {RANGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <div className="dr-datebox" ref={box}>
        {arrow(nav.prev, "prev")}
        <button type="button" className="dr-date-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <svg className="dr-cal-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>{periodLabel(period)}<span aria-hidden="true" className="dr-caret">▾</span>
        </button>
        {arrow(nav.next, "next")}
        {open && <Calendar period={period} tab={tab} reportDates={reportDates} today={today} onPick={() => setOpen(false)} />}
      </div>
      {nav.current !== period.anchor && <Link className="text-link dr-current" href={reportHref(period.range, nav.current, tab)} prefetch={false}>{CURRENT_LABEL[period.range]}</Link>}
    </div>
  );
}

function Calendar({ period, tab, reportDates, today, onPick }: { period: PeriodRange; tab: ReportTab; reportDates: string[]; today: string; onPick: () => void }) {
  const reports = useMemo(() => new Set(reportDates), [reportDates]);
  const months = useMemo(() => new Set(reportDates.map((date) => date.slice(0, 7))), [reportDates]);
  const first = reportDates[0] ?? today;
  const [view, setView] = useState(period.range === "month" ? `${period.from.slice(0, 4)}-01-01` : `${period.from.slice(0, 7)}-01`);

  if (period.range === "month") {
    const year = Number(view.slice(0, 4));
    const canPrev = year > Number(first.slice(0, 4));
    const canNext = year < Number(today.slice(0, 4));
    return (
      <div className="dr-calendar" role="dialog" aria-label="月を選ぶ">
        <div className="dr-cal-head">
          <button type="button" disabled={!canPrev} onClick={() => setView(`${year - 1}-01-01`)} aria-label="前の年">‹</button>
          <strong>{year}年</strong>
          <button type="button" disabled={!canNext} onClick={() => setView(`${year + 1}-01-01`)} aria-label="次の年">›</button>
        </div>
        <div className="dr-cal-months">
          {Array.from({ length: 12 }, (_, index) => {
            const month = `${year}-${String(index + 1).padStart(2, "0")}`;
            const selected = period.from.startsWith(month);
            return months.has(month) ? (
              <Link key={month} href={reportHref("month", `${month}-01`, tab)} prefetch={false} onClick={onPick} className={selected ? "is-selected" : ""} aria-current={selected ? "date" : undefined}>{index + 1}月</Link>
            ) : (
              <span key={month} className="is-empty">{index + 1}月</span>
            );
          })}
        </div>
        <p className="dr-note">日報のある月だけ選べます</p>
      </div>
    );
  }

  const canPrev = view.slice(0, 7) > first.slice(0, 7);
  const canNext = view.slice(0, 7) < today.slice(0, 7);
  const lead = weekdayIndex(view);
  const start = addDays(view, -lead);
  const end = addDays(addMonths(view, 1), -1);
  const weeks: string[][] = [];
  for (let monday = start; monday <= end; monday = addDays(monday, 7)) weeks.push(Array.from({ length: 7 }, (_, index) => addDays(monday, index)));
  const inMonth = (date: string) => date.slice(0, 7) === view.slice(0, 7);

  return (
    <div className="dr-calendar" role="dialog" aria-label={period.range === "week" ? "週を選ぶ" : "日を選ぶ"}>
      <div className="dr-cal-head">
        <button type="button" disabled={!canPrev} onClick={() => setView(addMonths(view, -1))} aria-label="前の月">‹</button>
        <strong>{Number(view.slice(0, 4))}年{Number(view.slice(5, 7))}月</strong>
        <button type="button" disabled={!canNext} onClick={() => setView(addMonths(view, 1))} aria-label="次の月">›</button>
      </div>
      <div className="dr-cal-row dr-cal-weekdays" aria-hidden="true">{["月", "火", "水", "木", "金", "土", "日"].map((label) => <span key={label}>{label}</span>)}</div>
      {weeks.map((week) => {
        const cells = week.map((date) => (
          <span key={date} className={[inMonth(date) ? "" : "is-outside", reports.has(date) ? "has-report" : "is-empty"].filter(Boolean).join(" ")}>{Number(date.slice(8, 10))}</span>
        ));
        if (period.range === "week") {
          const selected = week[0] === period.from;
          return week.some((date) => reports.has(date)) ? (
            <Link key={week[0]} href={reportHref("week", week[0], tab)} prefetch={false} onClick={onPick} className={`dr-cal-row is-week${selected ? " is-selected" : ""}`} aria-current={selected ? "date" : undefined} aria-label={`${week[0]}の週`}>{cells}</Link>
          ) : (
            <div key={week[0]} className="dr-cal-row is-week is-disabled">{cells}</div>
          );
        }
        return (
          <div key={week[0]} className="dr-cal-row">
            {week.map((date) => {
              const selected = date === period.from;
              const label = Number(date.slice(8, 10));
              const classes = [inMonth(date) ? "" : "is-outside", selected ? "is-selected" : ""].filter(Boolean).join(" ");
              return reports.has(date) ? (
                <Link key={date} href={reportHref("day", date, tab)} prefetch={false} onClick={onPick} className={`has-report ${classes}`} aria-current={selected ? "date" : undefined} aria-label={date}>{label}</Link>
              ) : (
                <span key={date} className={`is-empty ${classes}`}>{label}</span>
              );
            })}
          </div>
        );
      })}
      <p className="dr-note">{period.range === "week" ? "日報のある週を行ごと選べます" : "印のある日(日報あり)だけ選べます"}</p>
    </div>
  );
}
