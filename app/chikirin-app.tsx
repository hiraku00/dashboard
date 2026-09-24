"use client";

import { useCallback, useState } from "react";
import { PortalHeader } from "./portal-nav";
import { readErrorMessage, readJson } from "./lib/json";
import { formatPostedAt, type Program, type ProgramKind } from "./lib/openchat-query.ts";
import { MAX_LIKE_TERM_BYTES, truncateUtf8Bytes, utf8ByteLength } from "./lib/sql-text.ts";
import { useLatestRequest } from "./lib/use-latest-request";
import { useSearchReload } from "./lib/use-search-reload";

export type ProgramsPage = { programs: Program[]; nextCursor: string | null };
export type RunSummary = {
  status: string; startedAt: string; completedAt: string | null; notesScanned: number; notesOpened: number;
  commentsNew: number; targetCommentsNew: number; warningCount: number;
} | null;

const kindLabel: Record<ProgramKind, string> = { all: "すべて", thread: "ちきりんさんのスレッド", comment: "ちきりんさんのコメント" };
const runStatusLabel: Record<string, string> = { success: "成功", partial: "一部に警告あり", failed: "失敗", aborted: "中断", started: "実行中" };

function runLine(run: RunSummary) {
  if (!run) return "まだ同期されていません。Macで collector/line_openchat の同期を実行してください。";
  const stamp = new Date(run.completedAt ?? run.startedAt);
  const when = Number.isNaN(stamp.getTime()) ? "" : formatPostedAt(stamp.toISOString().replace(/\.\d+Z$/, "Z"), "exact");
  const warn = run.warningCount ? `・警告 ${run.warningCount} 件` : "";
  return `最後の同期: ${when}（${runStatusLabel[run.status] ?? run.status}）・新しいちきりんさんのコメント ${run.targetCommentsNew} 件${warn}`;
}

/** 折りたたみ: 長い本文は最初の数行だけ見せ、押すと全文にする。 */
function Body({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 280 || text.split("\n").length > 7;
  return <div className="chikirin-body">
    <p className={long && !open ? "chikirin-text is-clamped" : "chikirin-text"}>{text}</p>
    {long && <button type="button" className="chikirin-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "閉じる" : "全文を表示"}</button>}
  </div>;
}

export function ChikirinApp({ initialPage = null, initialRun = null }: { initialPage?: ProgramsPage | null; initialRun?: RunSummary } = {}) {
  const [programs, setPrograms] = useState<Program[]>(initialPage?.programs ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(initialPage?.nextCursor ?? null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ProgramKind>("all");
  const [loading, setLoading] = useState(!initialPage);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState("");
  const { begin, isCurrent } = useLatestRequest();

  const params = useCallback((cursor?: string | null) => {
    const p = new URLSearchParams();
    if (query) p.set("q", query);
    if (kind !== "all") p.set("kind", kind);
    if (cursor) p.set("cursor", cursor);
    return p;
  }, [query, kind]);

  const reload = useCallback(async () => {
    const requestId = begin();
    setLoading(true);
    setNotice("");
    try {
      const response = await fetch(`/api/openchat/programs?${params()}`);
      if (!response.ok) throw new Error(await readErrorMessage(response, "一覧を読み込めませんでした。再読み込みしてください。"));
      const page = await readJson<ProgramsPage>(response);
      if (!isCurrent(requestId)) return;
      setPrograms(page.programs);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (isCurrent(requestId)) setNotice(error instanceof Error ? error.message : "読み込みに失敗しました。");
    } finally {
      if (isCurrent(requestId)) setLoading(false);
    }
  }, [params, begin, isCurrent]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const requestId = begin();
    setLoadingMore(true);
    try {
      const response = await fetch(`/api/openchat/programs?${params(nextCursor)}`);
      if (!response.ok) throw new Error(await readErrorMessage(response, "続きを読み込めませんでした。"));
      const page = await readJson<ProgramsPage>(response);
      if (!isCurrent(requestId)) return;
      setPrograms((current) => [...current, ...page.programs]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (isCurrent(requestId)) setNotice(error instanceof Error ? error.message : "読み込みに失敗しました。");
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, params, begin, isCurrent]);

  // サーバーが同じ既定の表示(絞り込みなし)を描いていれば、最初の1回は読み直さない。
  useSearchReload(reload, query, Boolean(initialPage));

  return <main className="app-shell">
    <PortalHeader title="ちきりんオプチャ" active="/chikirin" />
    {notice && <p className="notice toast-notice" role="alert">{notice}</p>}
    <section className="library-panel" aria-labelledby="chikirin-title">
      <div className="library-heading">
        <h2 id="chikirin-title">番組ごとのちきりんさん</h2>
        <span className="result-count">{loading ? "読み込み中" : `${programs.length} 件${nextCursor ? "以上" : ""}`}</span>
      </div>
      <p className="chikirin-run" data-testid="run-line">{runLine(initialRun)}</p>
      <div className="filters chikirin-filters">
        <label className="search"><span aria-hidden="true">⌕</span>
          <input value={query} onChange={(event) => setQuery(truncateUtf8Bytes(event.target.value, MAX_LIKE_TERM_BYTES))}
            placeholder="番組名、ちきりんさんの投稿を検索" aria-label="検索"
            title={`検索語は${MAX_LIKE_TERM_BYTES}バイトまで（今 ${utf8ByteLength(query)} バイト）`} />
        </label>
        <div className="chikirin-kinds" role="group" aria-label="表示する投稿">
          {(Object.keys(kindLabel) as ProgramKind[]).map((key) => <button type="button" key={key} className={key === kind ? "chikirin-kind is-active" : "chikirin-kind"} aria-pressed={key === kind} onClick={() => setKind(key)}>{kindLabel[key]}</button>)}
        </div>
      </div>
      {!loading && programs.length === 0 && <div className="empty-state"><strong>該当する番組はありません。</strong><p>{initialRun || query || kind !== "all" ? "条件を変えてみてください。" : "同期が終わるとここに表示されます。"}</p></div>}
      <div className={loading ? "chikirin-list is-loading" : "chikirin-list"} aria-busy={loading}>
        {programs.map((program) => <article className="chikirin-card" key={program.noteId}>
          <header>
            <h3>{program.programTitle || "（題名なし）"}</h3>
            <p className="chikirin-meta">
              <span>{program.noteByTarget ? "ちきりんさんのスレッド" : `スレッド: ${program.noteAuthor}`}</span>
              <time dateTime={program.notePostedAt}>{formatPostedAt(program.notePostedAt, program.notePrecision)}</time>
              <span>コメント {program.commentCount} 件</span>
            </p>
            {(program.linkTitle || program.linkUrl) && <p className="chikirin-link">
              {program.linkUrl ? <a href={program.linkUrl} target="_blank" rel="noreferrer">{program.linkTitle || program.linkUrl} <span aria-hidden="true">↗</span></a> : program.linkTitle}
            </p>}
          </header>
          {program.targetBody !== null && <section className="chikirin-post is-thread" aria-label="ちきりんさんのスレッド">
            <strong className="chikirin-badge">ちきりんさんのスレッド</strong>
            <Body text={program.targetBody} />
          </section>}
          {program.targetComments.map((comment) => <section className="chikirin-post is-comment" key={comment.id} aria-label="ちきりんさんのコメント">
            <div className="chikirin-post-head"><strong className="chikirin-badge">{program.noteByTarget ? "本人コメント" : "ちきりんさんのコメント"}</strong><time dateTime={comment.postedAt}>{formatPostedAt(comment.postedAt, comment.precision)}</time></div>
            <Body text={comment.bodyText} />
          </section>)}
        </article>)}
      </div>
      {nextCursor && <div className="chikirin-more"><button type="button" onClick={loadMore} disabled={loadingMore}>{loadingMore ? "読み込み中…" : "さらに読み込む"}</button></div>}
    </section>
  </main>;
}
