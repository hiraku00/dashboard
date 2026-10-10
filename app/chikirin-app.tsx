"use client";

import { useCallback, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { PortalHeader } from "./portal-nav";
import { readErrorMessage, readJson } from "./lib/json";
import { inferBroadcaster, siteOf } from "./lib/openchat-meta.ts";
import { formatPostedAt, type Program, type ProgramKind, type ProgramSort } from "./lib/openchat-query.ts";
import { MAX_LIKE_TERM_BYTES, truncateUtf8Bytes, utf8ByteLength } from "./lib/sql-text.ts";
import { watchListSearchTerm } from "./lib/text.ts";
import { useLatestRequest } from "./lib/use-latest-request";
import { useSearchReload } from "./lib/use-search-reload";

/** Watch List での登録状況: url=保存URL、title=項目名、count=項目数、status=同じリンクの項目のうち最も進んだ状態(完了 > 鑑賞中 > 未着手 > 見送り)、watchedOn=完了日。 */
export type WatchedInfo = { url: string; title: string; count: number; status?: string; watchedOn?: string | null };
export type ProgramsPage = { programs: Program[]; total: number; page: number; pageSize: number; watched?: Record<string, WatchedInfo> };
export type RunSummary = {
  status: string; startedAt: string; completedAt: string | null; notesScanned: number; notesOpened: number;
  commentsNew: number; targetCommentsNew: number; warningCount: number; warnings?: string[]; newPrograms?: number; newSince?: string;
} | null;

const kindLabel: Record<ProgramKind, string> = { all: "すべて", involved: "ちきりんあり", thread: "ちきりんのスレッド", comment: "ちきりんのコメント", none: "ちきりんなし" };
const sortLabel: Record<ProgramSort, string> = { posted: "スレッド起票日時", latest: "最新ちきりん" };
const runStatusLabel: Record<string, string> = { success: "成功", partial: "一部に警告あり", failed: "失敗", aborted: "中断", started: "実行中" };

/** 最後の取得: collector が読み取りを始めた時刻(送信が遅れても、取得の時刻)。日時はすべて日本時間(JST)。 */
function runLine(run: RunSummary) {
  if (!run) return "まだ同期されていません。Macで collector/line_openchat の同期を実行してください。";
  const stamp = new Date(run.startedAt);
  const when = Number.isNaN(stamp.getTime()) ? "" : formatPostedAt(stamp.toISOString().replace(/\.\d+Z$/, "Z"), "exact");
  return `最後の取得: ${when} JST（${runStatusLabel[run.status] ?? run.status}）${run.newPrograms === undefined ? "" : `・新着 ${run.newPrograms} 番組（新しいスレッド、またはちきりんの新しい投稿が見つかった番組。一覧の「新着」）`}`;
}

/** 最後の取得で、新しいスレッド、またはちきりんの新しい投稿(スレッド・コメント)が見つかった番組か。 */
function isNew(program: Program, run: RunSummary) {
  if (!run || !program.newestSeenAt) return false;
  const seen = Date.parse(program.newestSeenAt), since = Date.parse(run.newSince ?? run.startedAt);
  return !Number.isNaN(seen) && !Number.isNaN(since) && seen >= since;
}

/** 一覧のタイトル欄: 詳細で設定したその日の放送タイトル。 */
export function titleLines(program: Program): { title: string } {
  return { title: program.meta.episodeTitle };
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

/** 一覧・詳細に出すリンク: 放送情報で編集したリンクがあればそれ、無ければノートの生リンクカードのURL
 *  (放送局の自動設定と同じ扱い。編集・削除はできない参考表示で、保存すると編集したリンクに置き換わる)。 */
export function displayLinks(program: Program): Array<{ url: string; label: string; text: string }> {
  if (program.meta.links.length > 0) return program.meta.links.map((l) => ({ url: l.url, label: l.label, text: linkText(l.url, l.label) }));
  return program.linkUrl ? [{ url: program.linkUrl, label: "", text: linkText(program.linkUrl, "") }] : [];
}

const WATCH_RANK: Record<string, number> = { completed: 3, in_progress: 2, backlog: 1 };
const watchRank = (status?: string) => WATCH_RANK[status ?? ""] ?? 0;

/** 一覧のリンク列: 1件目だけを出し、2件目以降は「+N」で開閉する(開くと残りが縦に並び、それぞれ押せる)。 */
function ProgramLinks({ links, label }: { links: Array<{ url: string; text: string }>; label: string }) {
  const [open, setOpen] = useState(false);
  const shown = open ? links : links.slice(0, 1);
  return <div className="item-links" aria-label={label}>
    {shown.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noreferrer" title={l.url}>{l.text} ↗</a>)}
    {links.length > 1 && <button type="button" className="link-more" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? "閉じる" : `残り ${links.length - 1} 件のリンクを表示`}>{open ? "閉じる" : `+${links.length - 1}`}</button>}
  </div>;
}

// collector/README.md「ちきりんオプチャ（LINE）」節と同じ同期の仕方(READMEは cd collector してから打つ形)。Client IDは秘密ではない
// (collector/launchd/com.watch-list.manage-asset-collector.plist.template を参照。秘密のClient Secretは
// コマンドが自動でmacOS Keychainから読むため、コマンドには含まれない)。
const SYNC_CLIENT_ID = "f47d396cd28306989ca5737cce5a006c.access";
const SYNC_ENV = `PYTHONPATH=collector PORTAL_URL=https://dashboard.hiraku00.workers.dev PORTAL_SYNC_CLIENT_ID='${SYNC_CLIENT_ID}'`;
// リポジトリの直下(dashboard)で、cd せずにそのまま打てる形。台帳などの保存先は collector/line_openchat の場所から決まるので、
// どこで実行しても同じ(collector/data/line_openchat)
const SYNC_COMMANDS = [
  { label: "同期コマンド(リポジトリの直下で実行。数分かかる)", command: `${SYNC_ENV} python3 -m line_openchat.sync` },
  { label: "初回だけ: 依存パッケージのインストール", command: "python3 -m pip install -r collector/line_openchat/requirements.txt" },
  { label: "一覧の最後まで全件を読み直したいとき(台帳が無い場合など)", command: `${SYNC_ENV} python3 -m line_openchat.sync --first-run` },
];

/** コマンド1つ分の表示: コピー押下で navigator.clipboard へ、失敗したら選択状態にする。 */
function CopyableCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const range = document.createRange();
      if (preRef.current) { range.selectNodeContents(preRef.current); window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range); }
    }
  };
  return <div className="sync-command">
    <p>{label}</p>
    <div className="sync-command-row">
      <pre ref={preRef}>{command}</pre>
      <button type="button" onClick={copy}>{copied ? "コピーしました" : "コピー"}</button>
    </div>
  </div>;
}

/** 「同期コマンド」リンク: ノート取得(collector/line_openchat)の実行コマンドをポップアップで見せ、コピーできるようにする。
 *  忘れがちな前提(LINEでノートを開いておく・画面ロック解除・実行中は操作しない)も添える。 */
function SyncCommandHelp() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="chikirin-sync-help" onClick={() => setOpen(true)}>同期コマンド</button>
    {open && <div className="modal-backdrop" role="presentation" onClick={() => setOpen(false)}>
      <section className="editor sync-command-editor" role="dialog" aria-modal="true" aria-labelledby="sync-command-title" onClick={(event) => event.stopPropagation()}>
        <div className="editor-heading"><h2 id="sync-command-title">ノートの同期コマンド</h2><button className="close-button" onClick={() => setOpen(false)} aria-label="閉じる">×</button></div>
        <p className="sync-command-prereq">前提: LINEを起動し、対象のオープンチャットの「ノート」を開いておく(自動では開けません)。画面ロックを解除しておく。実行中(数分間)はマウス・キーボードに触らない(触ると中断します)。</p>
        {SYNC_COMMANDS.map((c) => <CopyableCommand key={c.label} label={c.label} command={c.command} />)}
        <p className="sync-command-doc">詳しくは <code>collector/README.md</code>「ちきりんオプチャ（LINE）」を参照。</p>
      </section>
    </div>}
  </>;
}

export function ChikirinApp({ initialPage = null, initialRun = null, initialQuery = "", initialKind = "all", initialSort = "posted" }: { initialPage?: ProgramsPage | null; initialRun?: RunSummary; initialQuery?: string; initialKind?: ProgramKind; initialSort?: ProgramSort } = {}) {
  const [programs, setPrograms] = useState<Program[]>(initialPage?.programs ?? []);
  const [watched, setWatched] = useState(initialPage?.watched ?? {});
  const [total, setTotal] = useState(initialPage?.total ?? 0);
  const [pageSize, setPageSize] = useState(initialPage?.pageSize ?? 10);
  const [page, setPage] = useState(initialPage?.page ?? 1);
  const [query, setQuery] = useState(initialQuery);
  const [kind, setKind] = useState<ProgramKind>(initialKind);
  const [sort, setSort] = useState<ProgramSort>(initialSort);
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
      if (sort !== "posted") p.set("sort", sort);
      if (page > 1) p.set("page", String(page));
      const response = await fetch(`/api/openchat/programs?${p}`);
      if (!response.ok) throw new Error(await readErrorMessage(response, "一覧を読み込めませんでした。再読み込みしてください。"));
      const next = await readJson<ProgramsPage>(response);
      if (!isCurrent(requestId)) return;
      setPrograms(next.programs);
      setWatched(next.watched ?? {});
      setTotal(next.total);
      setPageSize(next.pageSize);
    } catch (error) {
      if (isCurrent(requestId)) setNotice(error instanceof Error ? error.message : "読み込みに失敗しました。");
    } finally {
      if (isCurrent(requestId)) setLoading(false);
    }
  }, [query, kind, sort, page, begin, isCurrent]);

  // サーバーが同じ既定の表示(絞り込みなし・1ページ目)を描いていれば、最初の1回は読み直さない。
  useSearchReload(reload, query, Boolean(initialPage));

  // 詳細への行リンクに、一覧の検索・絞り込み・ページを付ける。詳細で保存したら、同じクエリで一覧へ戻れる(位置が変わらない)。
  const listQuery = new URLSearchParams();
  if (query) listQuery.set("q", query);
  if (kind !== "all") listQuery.set("kind", kind);
  if (sort !== "posted") listQuery.set("sort", sort);
  if (page > 1) listQuery.set("page", String(page));
  const listQuerySuffix = listQuery.toString() ? `?${listQuery}` : "";

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
      <div className="chikirin-run" data-testid="run-line">{runLine(initialRun)}{initialRun && initialRun.warningCount > 0 && <details className="chikirin-warnings"><summary>警告 {initialRun.warningCount} 件</summary><ul>{(initialRun.warnings ?? []).map((w, i) => <li key={i}>{w}</li>)}</ul></details>}<SyncCommandHelp /></div>
      <div className="filters chikirin-filters">
        <label className="search"><span aria-hidden="true">⌕</span>
          <input value={query} onChange={(event) => { setPage(1); setQuery(truncateUtf8Bytes(event.target.value, MAX_LIKE_TERM_BYTES)); }}
            placeholder="番組名、ちきりんの投稿を検索" aria-label="検索"
            title={`検索語は${MAX_LIKE_TERM_BYTES}バイトまで（今 ${utf8ByteLength(query)} バイト）`} />
        </label>
        <div className="chikirin-kinds" role="group" aria-label="表示する投稿">
          {(Object.keys(kindLabel) as ProgramKind[]).map((key) => <button type="button" key={key} className={key === kind ? "chikirin-kind is-active" : "chikirin-kind"} aria-pressed={key === kind} onClick={() => { setPage(1); setKind(key); }}>{kindLabel[key]}</button>)}
        </div>
        <div className="chikirin-kinds" role="group" aria-label="並び順">
          {(Object.keys(sortLabel) as ProgramSort[]).map((key) => <button type="button" key={key} className={key === sort ? "chikirin-kind is-active" : "chikirin-kind"} aria-pressed={key === sort} title={key === "latest" ? "ちきりんの最新の投稿が新しい順(ちきりんが関わらないスレッドは最後)" : "スレッドの起票日時が新しい順"} onClick={() => { setPage(1); setSort(key); }}>{sortLabel[key]}順</button>)}
        </div>
      </div>
      {!loading && programs.length === 0 && <div className="empty-state"><strong>該当する番組はありません。</strong><p>{initialRun || query || kind !== "all" ? "条件を変えてみてください。" : "同期が終わるとここに表示されます。"}</p></div>}
      {programs.length > 0 && <div className={loading ? "table-scroll is-loading" : "table-scroll"} aria-busy={loading}>
        <table className="content-table chikirin-table">
          <colgroup><col className="col-broadcaster" /><col className="col-thumb" /><col className="col-title" /><col className="col-owner" /><col className="col-posted" /><col className="col-posted" /><col className="col-count" /><col className="col-count" /><col className="col-status" /><col className="col-links" /><col className="col-texttube" /><col className="col-texttube" /></colgroup>
          <thead><tr>
            <th scope="col">番組</th><th scope="col" colSpan={2}>タイトル</th><th scope="col">スレ主</th><th scope="col" title="スレッドが起票された日時(日本時間)"><span className="head-2">スレッド<br />起票日時</span></th>
            <th scope="col" title="ちきりんの最新の投稿の日時"><span className="head-2">最新<br />ちきりん</span></th>
            <th scope="col" className="num" title="ノート全体のコメント数"><span className="head-2">コメ<br />全体</span></th><th scope="col" className="num" title="ちきりんが書いたコメントの数"><span className="head-2">コメ<br />ちき</span></th><th scope="col" className="center">状態</th><th scope="col">リンク</th><th scope="col"><span className="head-2">Watch<br />List</span></th><th scope="col">視聴</th>
          </tr></thead>
          <tbody>{programs.map((program) => {
            const links = displayLinks(program);
            const watchedLinks = links.filter((l) => watched[l.url]);
            return <tr key={program.noteId}>
              <td className="program-cell is-broadcaster">
                <strong className="program-broadcaster" title={displayBroadcaster(program) || undefined}>{displayBroadcaster(program) || "—"}</strong>
                <span className={program.meta.programName ? "program-name" : "program-name is-unset"} title={program.meta.programName || undefined}>{program.meta.programName || "番組名未設定"}</span>
              </td>
              <td className="thumb-cell">{program.thumbnailUrl && <Image src={program.thumbnailUrl} alt="" width={72} height={40} unoptimized referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.hidden = true; }} />}</td>
              <td className="program-cell is-title">{(() => {
                const { title } = titleLines(program);
                const head = program.noteBody.replace(/\s+/g, " ").trim();
                return <><Link className={title ? "chikirin-row-title" : "chikirin-row-title is-unset"} href={`/chikirin/${encodeURIComponent(program.noteId)}${listQuerySuffix}`} prefetch={false} title={title || "タイトル未設定"}>{isNew(program, initialRun) && <span className="chikirin-new" title="最後の取得で、新しいスレッド、またはちきりんの新しい投稿が見つかりました">新着</span>}{title || "（タイトル未設定）"}</Link>{head && <p className="description" title={head}>{head.slice(0, 140)}</p>}</>;
              })()}</td>
              <td className={program.noteByTarget ? "owner-cell is-target" : "owner-cell"}>{program.noteByTarget ? "ちきりん" : program.noteAuthor}</td>
              <td className="date-cell is-posted"><time dateTime={program.notePostedAt}>{formatPostedAt(program.notePostedAt, program.notePrecision)}</time></td>
              <td className="date-cell is-latest">{program.latestAt ? <time dateTime={program.latestAt}>{formatPostedAt(program.latestAt, program.latestPrecision)}</time> : <span className="empty-cell">—</span>}</td>
              <td className="num-cell is-total">{program.commentCount}</td>
              <td className={program.targetComments.length > 0 ? "num-cell is-target-count is-hit" : "num-cell is-target-count"}>{program.involvement === "none" ? <span className="empty-cell">—</span> : program.targetComments.length}</td>
              <td className="status-cell center">{program.issues.length > 0 ? <span className="chikirin-issue" title={program.issues.join("\n")}>要確認</span> : <span className="empty-cell" title="取得に問題はありません">OK</span>}</td>
              <td className="links-cell">{links.length > 0 ? <ProgramLinks links={links} label={`${program.programTitle} のリンク`} /> : <span className="empty-cell">—</span>}</td>
              <td className="texttube-cell is-watchlist">{watchedLinks.length > 0 ? watchedLinks.map((l) => <a key={l.url} className="texttube-badge texttube-reflected" href={`/watch-list?q=${encodeURIComponent(watched[l.url].title || watchListSearchTerm(watched[l.url].url))}`} target="_blank" rel="noreferrer" title={`${l.text} は Watch List に登録済み(「${watched[l.url].title}」)。開くとその項目を表示します`}>登録済{watched[l.url].count > 1 ? ` ${watched[l.url].count}件` : ""}</a>) : <span className="empty-cell">—</span>}</td>
              <td className="texttube-cell is-watched">{(() => {
                const best = watchedLinks.map((l) => watched[l.url]).sort((x, y) => watchRank(y.status) - watchRank(x.status))[0];
                if (!best) return <span className="empty-cell">—</span>;
                const done = best.status === "completed";
                return <span className={done ? "texttube-badge texttube-reflected" : "texttube-badge texttube-none"} title={done ? `Watch List で視聴済${best.watchedOn ? `(${best.watchedOn})` : ""}` : "Watch List に登録済ですが、まだ視聴済ではありません"}>{done ? "視聴" : best.status === "in_progress" ? "鑑賞中" : "未視聴"}</span>;
              })()}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
      {pagination}
    </section>
  </main>;
}
