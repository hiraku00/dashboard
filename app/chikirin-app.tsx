"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { PortalHeader } from "./portal-nav";
import { readErrorMessage, readJson } from "./lib/json";
import { inferBroadcaster, siteOf } from "./lib/openchat-meta.ts";
import { formatPostedAt, type Program, type ProgramKind } from "./lib/openchat-query.ts";
import { MAX_LIKE_TERM_BYTES, truncateUtf8Bytes, utf8ByteLength } from "./lib/sql-text.ts";
import { useLatestRequest } from "./lib/use-latest-request";
import { useSearchReload } from "./lib/use-search-reload";

export type ProgramsPage = { programs: Program[]; total: number; page: number; pageSize: number };
export type RunSummary = {
  status: string; startedAt: string; completedAt: string | null; notesScanned: number; notesOpened: number;
  commentsNew: number; targetCommentsNew: number; warningCount: number; warnings?: string[]; newPrograms?: number;
} | null;

const kindLabel: Record<ProgramKind, string> = { all: "すべて", thread: "ちきりんのスレッド", comment: "ちきりんのコメント" };
const runStatusLabel: Record<string, string> = { success: "成功", partial: "一部に警告あり", failed: "失敗", aborted: "中断", started: "実行中" };

/** 最後の取得: collector が読み取りを始めた時刻(送信が遅れても、取得の時刻)。日時はすべて日本時間(JST)。 */
function runLine(run: RunSummary) {
  if (!run) return "まだ同期されていません。Macで collector/line_openchat の同期を実行してください。";
  const stamp = new Date(run.startedAt);
  const when = Number.isNaN(stamp.getTime()) ? "" : formatPostedAt(stamp.toISOString().replace(/\.\d+Z$/, "Z"), "exact");
  return `最後の取得: ${when} JST（${runStatusLabel[run.status] ?? run.status}）${run.newPrograms === undefined ? "" : `・新着 ${run.newPrograms} 番組（ちきりんの新しいスレッド・コメントが見つかった番組。一覧の「新着」）`}`;
}

/** 最後の取得で、ちきりんの投稿(スレッド・コメント)が初めて見つかった番組か。 */
function isNew(program: Program, run: RunSummary) {
  if (!run || !program.newestSeenAt) return false;
  const seen = Date.parse(program.newestSeenAt), started = Date.parse(run.startedAt);
  return !Number.isNaN(seen) && !Number.isNaN(started) && seen >= started;
}

/** 一覧のタイトル欄の2行: 1行目=番組名(編集した放送タイトル。編集するまでは空)、2行目=スレッドの冒頭。 */
export function titleLines(program: Program): { title: string; head: string } {
  const head = program.noteBody.replace(/\s+/g, " ").trim();
  return { title: program.meta.episodeTitle, head: head.length > 140 ? `${head.slice(0, 140)}…` : head };
}

/** リンクの表示名: ラベルがあればそれ、なければサイト名(NHK ONE・WBS など。openchat-meta.ts の SITES)、なければドメイン。 */
export function linkText(url: string, label: string) {
  if (label) return label;
  const site = siteOf(url);
  if (site) return site.name;
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/** 一覧・詳細に出す放送局: 編集した値があればそれ、なければリンク(編集したリンク→ノートのリンクカード)から自動で決める。 */
export function displayBroadcaster(program: Program): string {
  return program.meta.broadcaster || inferBroadcaster([...program.meta.links.map((l) => l.url), program.linkUrl].filter(Boolean));
}

/** 一覧のリンク列に出すリンク: 編集したリンク + ノートのリンクカード。 */
function listLinks(program: Program) {
  const links = program.meta.links.map((l) => ({ url: l.url, text: linkText(l.url, l.label) }));
  if (program.linkUrl && !links.some((l) => l.url === program.linkUrl)) links.push({ url: program.linkUrl, text: linkText(program.linkUrl, "") });
  return links;
}

export function ChikirinApp({ initialPage = null, initialRun = null }: { initialPage?: ProgramsPage | null; initialRun?: RunSummary } = {}) {
  const [programs, setPrograms] = useState<Program[]>(initialPage?.programs ?? []);
  const [total, setTotal] = useState(initialPage?.total ?? 0);
  const [pageSize, setPageSize] = useState(initialPage?.pageSize ?? 20);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ProgramKind>("all");
  const [loading, setLoading] = useState(!initialPage);
  const [notice, setNotice] = useState("");
  const { begin, isCurrent } = useLatestRequest();

  const reload = useCallback(async () => {
    const requestId = begin();
    setLoading(true);
    setNotice("");
    try {
      const p = new URLSearchParams();
      if (query) p.set("q", query);
      if (kind !== "all") p.set("kind", kind);
      if (page > 1) p.set("page", String(page));
      const response = await fetch(`/api/openchat/programs?${p}`);
      if (!response.ok) throw new Error(await readErrorMessage(response, "一覧を読み込めませんでした。再読み込みしてください。"));
      const next = await readJson<ProgramsPage>(response);
      if (!isCurrent(requestId)) return;
      setPrograms(next.programs);
      setTotal(next.total);
      setPageSize(next.pageSize);
    } catch (error) {
      if (isCurrent(requestId)) setNotice(error instanceof Error ? error.message : "読み込みに失敗しました。");
    } finally {
      if (isCurrent(requestId)) setLoading(false);
    }
  }, [query, kind, page, begin, isCurrent]);

  // サーバーが同じ既定の表示(絞り込みなし・1ページ目)を描いていれば、最初の1回は読み直さない。
  useSearchReload(reload, query, Boolean(initialPage));

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const pages = [...new Set([1, page - 1, page, page + 1, totalPages])].filter((n) => n >= 1 && n <= totalPages).sort((x, y) => x - y);
  const pagination = totalPages > 1 ? <nav className="pagination" aria-label="ページ移動">
    <button type="button" aria-label="前のページ" disabled={page === 1} onClick={() => setPage(page - 1)}>‹</button>
    {pages.map((value, index) => <span className="page-number" key={value}>{index > 0 && value - pages[index - 1] > 1 && <i aria-hidden="true">…</i>}<button type="button" className={value === page ? "current-page" : ""} aria-current={value === page ? "page" : undefined} onClick={() => setPage(value)}>{value}</button></span>)}
    <button type="button" aria-label="次のページ" disabled={page === totalPages} onClick={() => setPage(page + 1)}>›</button>
  </nav> : null;

  return <main className="app-shell">
    <PortalHeader title="ちきりんオプチャ" active="/chikirin" />
    {notice && <p className="notice toast-notice" role="alert">{notice}</p>}
    <section className="library-panel" aria-labelledby="chikirin-title">
      <div className="library-heading">
        <h2 id="chikirin-title">番組ごとのちきりん</h2>
        <span className="result-count">{loading ? "読み込み中" : `${total} 件中 ${from}–${to}`}<small className="chikirin-tz"> ・日時は日本時間(JST)</small></span>
      </div>
      <div className="chikirin-run" data-testid="run-line">{runLine(initialRun)}{initialRun && initialRun.warningCount > 0 && <details className="chikirin-warnings"><summary>警告 {initialRun.warningCount} 件</summary><ul>{(initialRun.warnings ?? []).map((w, i) => <li key={i}>{w}</li>)}</ul></details>}</div>
      <div className="filters chikirin-filters">
        <label className="search"><span aria-hidden="true">⌕</span>
          <input value={query} onChange={(event) => { setPage(1); setQuery(truncateUtf8Bytes(event.target.value, MAX_LIKE_TERM_BYTES)); }}
            placeholder="番組名、ちきりんの投稿を検索" aria-label="検索"
            title={`検索語は${MAX_LIKE_TERM_BYTES}バイトまで（今 ${utf8ByteLength(query)} バイト）`} />
        </label>
        <div className="chikirin-kinds" role="group" aria-label="表示する投稿">
          {(Object.keys(kindLabel) as ProgramKind[]).map((key) => <button type="button" key={key} className={key === kind ? "chikirin-kind is-active" : "chikirin-kind"} aria-pressed={key === kind} onClick={() => { setPage(1); setKind(key); }}>{kindLabel[key]}</button>)}
        </div>
      </div>
      {!loading && programs.length === 0 && <div className="empty-state"><strong>該当する番組はありません。</strong><p>{initialRun || query || kind !== "all" ? "条件を変えてみてください。" : "同期が終わるとここに表示されます。"}</p></div>}
      {programs.length > 0 && <div className={loading ? "table-scroll is-loading" : "table-scroll"} aria-busy={loading}>
        <table className="content-table chikirin-table">
          <colgroup><col className="col-kind" /><col className="col-broadcaster" /><col className="col-program" /><col className="col-owner" /><col className="col-posted" /><col className="col-posted" /><col className="col-count" /><col className="col-count" /><col className="col-status" /><col className="col-links" /></colgroup>
          <thead><tr>
            <th scope="col" className="kind-head">種別</th><th scope="col">放送局</th><th scope="col">タイトル</th><th scope="col">スレ主</th><th scope="col" title="スレッドが起票された日時(日本時間)"><span className="head-2">スレッド<br />起票日時</span></th>
            <th scope="col" title="ちきりんの最新の投稿の日時"><span className="head-2">最新<br />ちきりん</span></th>
            <th scope="col" className="num" title="ノート全体のコメント数"><span className="head-2">コメント<br />全体</span></th><th scope="col" className="num" title="ちきりんが書いたコメントの数"><span className="head-2">コメント<br />ちきりん</span></th><th scope="col" className="center">状態</th><th scope="col">リンク</th>
          </tr></thead>
          <tbody>{programs.map((program) => {
            const links = listLinks(program);
            return <tr key={program.noteId}>
              <td className="kind-cell"><span className={program.noteByTarget ? "chikirin-tag is-thread" : "chikirin-tag"}>{program.noteByTarget ? "スレッド" : "コメント"}</span></td>
              <td className="broadcaster-cell">{displayBroadcaster(program) || <span className="empty-cell">—</span>}</td>
              <td className="program-cell">{(() => {
                const { title, head } = titleLines(program);
                return <><Link className={title ? "chikirin-row-title" : "chikirin-row-title is-unset"} href={`/chikirin/${encodeURIComponent(program.noteId)}`} prefetch={false} title={title || program.programTitle}>{isNew(program, initialRun) && <span className="chikirin-new" title="最後の取得で、ちきりんの新しい投稿が見つかりました">新着</span>}{title || "（番組名 未設定）"}</Link><p className="description" title={head}>{head || " "}</p></>;
              })()}</td>
              <td className="owner-cell">{program.noteByTarget ? "ちきりん" : program.noteAuthor}</td>
              <td className="date-cell"><time dateTime={program.notePostedAt}>{formatPostedAt(program.notePostedAt, program.notePrecision)}</time></td>
              <td className="date-cell">{program.latestAt ? <time dateTime={program.latestAt}>{formatPostedAt(program.latestAt, program.latestPrecision)}</time> : <span className="empty-cell">—</span>}</td>
              <td className="num-cell">{program.commentCount}</td>
              <td className="num-cell">{program.targetComments.length}</td>
              <td className="status-cell center">{program.issues.length > 0 ? <span className="chikirin-issue" title={program.issues.join("\n")}>要確認</span> : <span className="empty-cell" title="取得に問題はありません">OK</span>}</td>
              <td className="links-cell">{links.length > 0 ? <div className="item-links" aria-label={`${program.programTitle} のリンク`}>{links.slice(0, 2).map((l) => <a key={l.url} href={l.url} target="_blank" rel="noreferrer" title={l.url}>{l.text} ↗</a>)}{links.length > 2 && <span className="empty-cell">+{links.length - 2}</span>}</div> : <span className="empty-cell">—</span>}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
      {pagination}
    </section>
  </main>;
}
