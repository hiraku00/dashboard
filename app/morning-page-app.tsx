"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { PortalHeader } from "./portal-nav";
import type { MorningPageModel } from "./lib/morning-page-model";

/** /morning-page のワークスペース(docs/morning-page-design.md)。日報の画面と同じく、ヘッダーの下の機能内タブで切り口を替え、
 *  全タブを描いて `hidden` で隠す(切り替えは即時、URLは tab だけ書き換える)。月はリンクで替え、サーバーが読み直す。 */

export type MorningTab = "overview" | "days" | "notes";
const TABS: [MorningTab, string][] = [["overview", "概要"], ["days", "日ごと"], ["notes", "気がかり"]];

const KIND_LABEL = { yesterday: "昨日のこと", plan: "今日の予定", notes: "気がかり" } as const;

const href = (month: string | null, tab: MorningTab) => `/morning-page?${month ? `month=${month}&` : ""}tab=${tab}`;
const minutesText = (minutes: number | null) => (minutes === null ? "—" : minutes < 60 ? `${minutes}分` : `${Math.floor(minutes / 60)}時間${String(minutes % 60).padStart(2, "0")}分`);
const shortDate = (date: string, weekday: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}(${weekday})`;

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

export function MorningPageApp({ model, initialTab }: { model: MorningPageModel; initialTab: MorningTab }) {
  const [tab, setTab] = useState<MorningTab>(initialTab);

  const selectTab = (next: MorningTab) => {
    setTab(next);
    try {
      window.history.replaceState(null, "", href(model.month, next));
    } catch {
      // history が使えない環境でも、タブの切り替え自体は動く
    }
  };

  return (
    <main className="portal-shell asset-workspace daily-report-workspace">
      <PortalHeader title="モーニングページ" active="/morning-page">
        <nav className="asset-tabs" aria-label="モーニングページ メニュー">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" className={tab === id ? "active" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => selectTab(id)}>
              {label}
            </button>
          ))}
        </nav>
      </PortalHeader>

      {model.empty ? (
        <section className="asset-panel dr-panel"><p className="dr-empty">モーニングページはまだありません。auto-daily-report の morning_pages.py で送ると表示されます。</p></section>
      ) : (
        <>
          <MonthPicker model={model} tab={tab} />
          <div hidden={tab !== "overview"}><OverviewTab model={model} /></div>
          <div hidden={tab !== "days"}><DaysTab model={model} /></div>
          <div hidden={tab !== "notes"}><NotesTab model={model} /></div>
        </>
      )}
    </main>
  );
}

/** 月の選択: 前後の月へ(データのある月だけ)と、年ごとの月のチップ。データの無い月は押せない */
function MonthPicker({ model, tab }: { model: MorningPageModel; tab: MorningTab }) {
  return (
    <section className="asset-panel dr-panel mp-picker">
      <div className="mp-picker-head">
        {model.prev ? <Link className="mp-step" href={href(model.prev, tab)} prefetch={false} aria-label="前の月">‹</Link> : <span className="mp-step is-off" aria-hidden="true">‹</span>}
        <strong>{model.monthLabel}</strong>
        {model.next ? <Link className="mp-step" href={href(model.next, tab)} prefetch={false} aria-label="次の月">›</Link> : <span className="mp-step is-off" aria-hidden="true">›</span>}
      </div>
      <div className="mp-years">
        {model.years.map((group) => (
          <div key={group.year} className="mp-year">
            <span>{group.year}</span>
            <div>
              {group.months.map((item) => (
                <Link key={item.month} href={href(item.month, tab)} prefetch={false} className={item.month === model.month ? "is-current" : undefined} title={`${item.pages}日分`}>{item.label}</Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Figure({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="dr-rf-figure">
      <p>{label}</p>
      <strong>{value}</strong>
      {sub ? <span>{sub}</span> : null}
    </div>
  );
}

/** 概要: 月の数字、日ごとの所要時間の棒、場所、月ごとの推移 */
function OverviewTab({ model }: { model: MorningPageModel }) {
  const { stats } = model;
  return (
    <div className="dr-stack">
      <section className="asset-panel dr-panel">
        <div className="dr-rf-figures mp-figures">
          <Figure label="書いた日" value={<>{stats.pages}<small>/{stats.daysInMonth}日</small></>} sub={stats.pages ? `${Math.round((stats.pages / stats.daysInMonth) * 100)}%` : "この月のページはありません"} />
          <Figure label="平均の所要時間" value={minutesText(stats.avgMinutes)} sub={stats.longest ? `最長 ${minutesText(stats.longest.minutes)}（${Number(stats.longest.date.slice(5, 7))}/${Number(stats.longest.date.slice(8, 10))}）` : undefined} />
          <Figure label="平均の文字数" value={stats.avgChars === null ? "—" : <>{stats.avgChars.toLocaleString("ja-JP")}<small>字</small></>} />
        </div>
      </section>

      <Panel title="日ごとの所要時間" sub="棒にポインタを重ねると、時間・文字数・場所が出ます。書かなかった日は点">
        <div className="mp-daybars" style={{ ["--days" as string]: model.dayBars.length }} role="img" aria-label={`${model.monthLabel}の日ごとの所要時間`}>
          {model.dayBars.map((bar) => (
            <div key={bar.date} className={`mp-daybar${bar.written ? "" : " is-off"}`} title={bar.written ? `${shortDate(bar.date, bar.weekday)} ${minutesText(bar.minutes)}${bar.chars !== null ? `・${bar.chars.toLocaleString("ja-JP")}字` : ""}${bar.place ? `・${bar.place}` : ""}` : `${shortDate(bar.date, bar.weekday)} 書かなかった日`}>
              <i style={{ height: bar.written && bar.minutes !== null ? `${Math.max(4, (bar.minutes / model.maxMinutes) * 100)}%` : undefined }} />
              <span>{bar.day % 5 === 0 || bar.day === 1 ? bar.day : ""}</span>
            </div>
          ))}
        </div>
      </Panel>

      <div className="dr-overview dr-original">
        <Panel title="場所" sub="この月のページ数（かっこの前でまとめています）">
          {model.places.length ? (
            <ul className="mp-places">
              {model.places.map((item) => <li key={item.place}><span>{item.place}</span><b>{item.count}日</b></li>)}
            </ul>
          ) : <p className="dr-empty">この月のページはありません。</p>}
        </Panel>
        <Panel title="月ごとの推移" sub="書いた日数と、平均の所要時間。月を押すとその月へ">
          <ol className="mp-trend">
            {model.trend.map((item) => (
              <li key={item.month} className={item.month === model.month ? "is-current" : undefined}>
                <Link href={href(item.month, "overview")} prefetch={false}>{item.label}</Link>
                <div className="mp-trend-track"><i style={{ width: `${item.avgMinutes === null ? 0 : (item.avgMinutes / model.maxTrendMinutes) * 100}%` }} /></div>
                <span>{item.pages}日・{minutesText(item.avgMinutes)}</span>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </div>
  );
}

function Items({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="mp-items">
      <h3>{title}</h3>
      <ul>{items.map((text, index) => <li key={index}>{text}</li>)}</ul>
    </div>
  );
}

/** 日ごと: 書いた日を1日ずつ開閉できる一覧。開くと「昨日のこと・今日の予定・気がかり」 */
function DaysTab({ model }: { model: MorningPageModel }) {
  if (!model.days.length) return <Panel title="日ごと"><p className="dr-empty">この月のページはありません。</p></Panel>;
  return (
    <Panel title="日ごと" sub={model.extractedDays ? `${model.days.length}日分。開くと、昨日のこと・今日の予定・気がかりが読めます` : `${model.days.length}日分。この月は、書いた時間と場所だけです`}>
      <ul className="mp-days">
        {model.days.map((day) => {
          const hasText = day.yesterday.length + day.plan.length + day.notes.length > 0;
          return (
            <li key={day.date}>
              <details>
                <summary>
                  <b>{shortDate(day.date, day.weekday)}</b>
                  <span>{day.startedAt && day.endedAt ? `${day.startedAt}〜${day.endedAt}` : "—"}</span>
                  <span>{minutesText(day.minutes)}</span>
                  <span>{day.chars === null ? "" : `${day.chars.toLocaleString("ja-JP")}字`}</span>
                  <em>{day.place}</em>
                </summary>
                <div className="mp-day-body">
                  <Items title="昨日のこと" items={day.yesterday} />
                  <Items title="今日の予定" items={day.plan} />
                  <Items title="気になったこと" items={day.notes} />
                  {day.extracted && !hasText ? <p className="dr-empty">この日のページには、取り出せる内容がありませんでした。</p> : null}
                  {day.reportLink ? <p className="mp-link"><Link className="text-link" href={day.reportLink} prefetch={false}>この日の予定と実績を、日報の振り返りで見る →</Link></p> : null}
                  {!day.extracted && !day.reportLink ? <p className="dr-empty">この日は、書いた時間と場所だけです。</p> : null}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/** 気がかり: 検索語があれば全期間の検索結果、無ければこの月の気がかりの一覧 */
function NotesTab({ model }: { model: MorningPageModel }) {
  const { search } = model;
  return (
    <div className="dr-stack">
      <section className="asset-panel dr-panel">
        <form className="mp-search" action="/morning-page" method="get">
          <input type="hidden" name="tab" value="notes" />
          <label className="dr-search">
            <span className="sr-only">全期間から検索</span>
            <input type="search" name="q" defaultValue={search?.q ?? ""} placeholder="全期間の昨日のこと・予定・気がかりから検索" maxLength={100} />
          </label>
          <button type="submit" className="secondary-button">検索</button>
          {search ? <Link className="text-link" href={href(model.month, "notes")} prefetch={false}>検索をやめる</Link> : null}
        </form>
      </section>
      {search ? (
        <Panel title={`「${search.q}」の検索結果`} sub={search.hits.length ? `${search.hits.length}件（新しい日から、最大60日分のページ）` : undefined}>
          {search.hits.length ? (
            <div className="dr-table-scroll">
              <table className="asset-table dr-notes-table">
                <thead><tr><th scope="col">日付</th><th scope="col">種類</th><th scope="col">内容</th></tr></thead>
                <tbody>
                  {search.hits.map((hit, index) => {
                    const firstOfDay = index === 0 || search.hits[index - 1].date !== hit.date;
                    return (
                      <tr key={`${hit.date}-${index}`} className={firstOfDay && index > 0 ? "is-new-day" : undefined}>
                        <th scope="row">{firstOfDay ? <Link href={href(hit.date.slice(0, 7), "days")} prefetch={false}>{hit.date}</Link> : null}</th>
                        <td><span className={`mp-kind is-${hit.kind}`}>{KIND_LABEL[hit.kind]}</span></td>
                        <td className="dr-note-text">{hit.text}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <p className="dr-empty">見つかりませんでした。</p>}
        </Panel>
      ) : (
        <Panel title="気がかり" sub={`${model.monthLabel}。新しい日から`}>
          {model.notes.length ? (
            <div className="dr-table-scroll">
              <table className="asset-table dr-notes-table">
                <thead><tr><th scope="col">日付</th><th scope="col">内容</th></tr></thead>
                <tbody>
                  {model.notes.map((note, index) => {
                    const firstOfDay = index === 0 || model.notes[index - 1].date !== note.date;
                    return (
                      <tr key={`${note.date}-${index}`} className={firstOfDay && index > 0 ? "is-new-day" : undefined}>
                        <th scope="row">{firstOfDay ? note.date : null}</th>
                        <td className="dr-note-text">{note.text}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <p className="dr-empty">{model.extractedDays ? "この月の気がかりはありません。" : "この月は、書いた時間と場所だけなので、気がかりの抜き出しはありません。"}</p>}
        </Panel>
      )}
    </div>
  );
}
