"use client";

import { useCallback, useState, type FormEvent } from "react";
import Link from "next/link";
import { PortalHeader } from "./portal-nav";
import { readErrorMessage, readJson } from "./lib/json";
import { MAX_BROADCASTER, MAX_EPISODE_TITLE, MAX_LINKS, MAX_LINK_LABEL, type Meta } from "./lib/openchat-meta.ts";
import { formatPostedAt, type Program, type ProgramKind } from "./lib/openchat-query.ts";
import { MAX_LIKE_TERM_BYTES, truncateUtf8Bytes, utf8ByteLength } from "./lib/sql-text.ts";
import { useLatestRequest } from "./lib/use-latest-request";
import { useSearchReload } from "./lib/use-search-reload";

export type ProgramsPage = { programs: Program[]; total: number; page: number; pageSize: number };
export type RunSummary = {
  status: string; startedAt: string; completedAt: string | null; notesScanned: number; notesOpened: number;
  commentsNew: number; targetCommentsNew: number; warningCount: number;
} | null;

const kindLabel: Record<ProgramKind, string> = { all: "すべて", thread: "ちきりんのスレッド", comment: "ちきりんのコメント" };
const runStatusLabel: Record<string, string> = { success: "成功", partial: "一部に警告あり", failed: "失敗", aborted: "中断", started: "実行中" };

function runLine(run: RunSummary) {
  if (!run) return "まだ同期されていません。Macで collector/line_openchat の同期を実行してください。";
  const stamp = new Date(run.completedAt ?? run.startedAt);
  const when = Number.isNaN(stamp.getTime()) ? "" : formatPostedAt(stamp.toISOString().replace(/\.\d+Z$/, "Z"), "exact");
  const warn = run.warningCount ? `・警告 ${run.warningCount} 件` : "";
  return `最後の同期: ${when}（${runStatusLabel[run.status] ?? run.status}）・新しいちきりんのコメント ${run.targetCommentsNew} 件${warn}`;
}

/** 一覧の1行に出す、内容の抜粋(1行)。ちきりんのスレッドは本文、コメントは最初のコメント。 */
function preview(program: Program) {
  const text = program.targetBody ?? program.targetComments[0]?.bodyText ?? "";
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}

/** リンクの表示名: ラベルがあればそれ、なければドメイン。 */
export function linkText(url: string, label: string) {
  if (label) return label;
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/** 一覧のリンク列に出すリンク: 編集したリンク + ノートのリンクカード。 */
function listLinks(program: Program) {
  const links = program.meta.links.map((l) => ({ url: l.url, text: linkText(l.url, l.label) }));
  if (program.linkUrl && !links.some((l) => l.url === program.linkUrl)) links.push({ url: program.linkUrl, text: linkText(program.linkUrl, "") });
  return links;
}

/** 放送局・その日の放送タイトル・リンクの編集。collector の同期データとは別に保存される。 */
function MetaEditor({ program, onClose, onSaved }: { program: Program; onClose: () => void; onSaved: (program: Program) => void }) {
  const [draft, setDraft] = useState<Meta>({ broadcaster: program.meta.broadcaster, episodeTitle: program.meta.episodeTitle, links: program.meta.links.map((l) => ({ ...l })) });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const setLink = (index: number, patch: Partial<Meta["links"][number]>) => setDraft({ ...draft, links: draft.links.map((l, i) => (i === index ? { ...l, ...patch } : l)) });
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/openchat/programs/${encodeURIComponent(program.noteId)}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(draft),
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, "保存できませんでした。"));
      onSaved((await readJson<{ program: Program }>(response)).program);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存できませんでした。");
      setSaving(false);
    }
  };
  return <div className="modal-backdrop" role="presentation" onClick={onClose}>
    <section className="editor" role="dialog" aria-modal="true" aria-labelledby="chikirin-editor-title" onClick={(event) => event.stopPropagation()}>
      <form onSubmit={save}>
        <div className="editor-heading"><div><p className="app-kicker">EDIT</p><h2 id="chikirin-editor-title">放送情報を編集</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="閉じる">×</button></div>
        <p className="chikirin-editor-note">スレッド: {program.programTitle || "（題名なし）"}</p>
        {error && <p className="notice" role="alert">{error}</p>}
        <div className="form-grid">
          <label>放送局<input value={draft.broadcaster} maxLength={MAX_BROADCASTER} onChange={(event) => setDraft({ ...draft, broadcaster: event.target.value })} placeholder="例：NHK BS、テレビ東京" /></label>
          <label>その日の放送タイトル<input value={draft.episodeTitle} maxLength={MAX_EPISODE_TITLE} onChange={(event) => setDraft({ ...draft, episodeTitle: event.target.value })} placeholder="例：BSスペシャル 禁じられる物語" /></label>
        </div>
        <div className="links-editor"><div><span>リンク</span><button type="button" disabled={draft.links.length >= MAX_LINKS} onClick={() => setDraft({ ...draft, links: [...draft.links, { url: "", label: "" }] })}>＋ リンクを追加</button></div>
          {draft.links.map((link, index) => <div className="link-row" key={index}>
            <input type="url" value={link.url} onChange={(event) => setLink(index, { url: event.target.value })} placeholder="https://" aria-label={`リンク${index + 1}のURL`} />
            <input value={link.label} maxLength={MAX_LINK_LABEL} onChange={(event) => setLink(index, { label: event.target.value })} placeholder="表示名（省略可）" aria-label={`リンク${index + 1}の表示名`} />
            <button type="button" aria-label={`リンク${index + 1}を削除`} onClick={() => setDraft({ ...draft, links: draft.links.filter((_, i) => i !== index) })}>×</button>
          </div>)}
        </div>
        <div className="editor-actions"><button type="button" className="cancel-button" onClick={onClose}>キャンセル</button><button className="save-button" disabled={saving}>{saving ? "保存中…" : "保存"}</button></div>
      </form>
    </section>
  </div>;
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
  const [editing, setEditing] = useState<Program | null>(null);
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
        <span className="result-count">{loading ? "読み込み中" : `${total} 件中 ${from}–${to}`}</span>
      </div>
      <p className="chikirin-run" data-testid="run-line">{runLine(initialRun)}</p>
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
          <colgroup><col className="col-kind" /><col className="col-broadcaster" /><col className="col-episode" /><col className="col-program" /><col className="col-owner" /><col className="col-posted" /><col className="col-count" /><col className="col-count" /><col className="col-posted" /><col className="col-links" /><col className="col-action" /></colgroup>
          <thead><tr>
            <th scope="col" className="kind-head">種別</th><th scope="col">放送局</th><th scope="col">放送タイトル</th><th scope="col" title="LINEのスレッドの1行目">スレッド</th><th scope="col">スレ主</th><th scope="col">投稿</th>
            <th scope="col" className="num" title="ノート全体のコメント数">コメ</th><th scope="col" className="num" title="ちきりんのコメント数">ちきりん</th><th scope="col" title="ちきりんの最新の投稿">最新</th><th scope="col">リンク</th><th scope="col"><span className="sr-only">編集</span></th>
          </tr></thead>
          <tbody>{programs.map((program) => {
            const links = listLinks(program);
            return <tr key={program.noteId}>
              <td className="kind-cell"><span className={program.noteByTarget ? "chikirin-tag is-thread" : "chikirin-tag"}>{program.noteByTarget ? "スレッド" : "コメント"}</span></td>
              <td className="broadcaster-cell">{program.meta.broadcaster || <span className="empty-cell">—</span>}</td>
              <td className="episode-cell">{program.meta.episodeTitle || <span className="empty-cell">—</span>}</td>
              <td className="program-cell"><Link className="chikirin-row-title" href={`/chikirin/${encodeURIComponent(program.noteId)}`} title={program.programTitle}>{program.programTitle || "（題名なし）"}</Link><p className="description" title={preview(program)}>{preview(program) || " "}</p></td>
              <td className="owner-cell">{program.noteByTarget ? "ちきりん" : program.noteAuthor}</td>
              <td className="date-cell"><time dateTime={program.notePostedAt}>{formatPostedAt(program.notePostedAt, program.notePrecision)}</time></td>
              <td className="num-cell">{program.commentCount}</td>
              <td className="num-cell">{program.targetComments.length}</td>
              <td className="date-cell">{program.latestAt ? <time dateTime={program.latestAt}>{formatPostedAt(program.latestAt, program.latestPrecision)}</time> : <span className="empty-cell">—</span>}</td>
              <td className="links-cell">{links.length > 0 ? <div className="item-links" aria-label={`${program.programTitle} のリンク`}>{links.slice(0, 2).map((l) => <a key={l.url} href={l.url} target="_blank" rel="noreferrer" title={l.url}>{l.text} ↗</a>)}{links.length > 2 && <span className="empty-cell">+{links.length - 2}</span>}</div> : <span className="empty-cell">—</span>}</td>
              <td className="action-cell"><button type="button" className="icon-button" onClick={() => setEditing(program)} aria-label={`${program.programTitle} の放送情報を編集`}>編集</button></td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
      {pagination}
    </section>
    {editing && <MetaEditor program={editing} onClose={() => setEditing(null)} onSaved={(saved) => { setPrograms((current) => current.map((p) => (p.noteId === saved.noteId ? saved : p))); setEditing(null); }} />}
  </main>;
}
