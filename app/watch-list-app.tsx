"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { PortalHeader } from "./portal-nav";
import { ApiError, readJson } from "./lib/json";

type ContentType = "text" | "audio" | "movie" | "other";
type Status = "backlog" | "in_progress" | "completed" | "dropped";
type Link = { id?: string; label: string; url: string; linkType?: string };
type Item = { id: string; contentType: ContentType; creatorName: string; seriesTitle: string; title: string; description: string; priority: number | null; status: Status; addedOn: string | null; watchedOn: string | null; comment: string; version: number; links: Link[] };
type Draft = Omit<Item, "id" | "version">;
type Stats = { total: number; completed: number; movie: number; audio: number; text: number };

const emptyDraft = (): Draft => ({ contentType: "movie", creatorName: "", seriesTitle: "", title: "", description: "", priority: null, status: "backlog", addedOn: new Date().toISOString().slice(0, 10), watchedOn: null, comment: "", links: [{ label: "", url: "", linkType: "reference" }] });
const typeLabel: Record<ContentType, string> = { movie: "映像", audio: "音声", text: "テキスト", other: "その他" };
const statusLabel: Record<Status, string> = { backlog: "未着手", in_progress: "鑑賞中", completed: "完了", dropped: "見送り" };
const dateLabel = (value: string | null) => value ? value.replaceAll("-", ".") : "未設定";
const pageSize = 10;

export function WatchListApp() {
  const [items, setItems] = useState<Item[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, completed: 0, movie: 0, audio: 0, text: 0 });
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"all" | ContentType>("all");
  const [status, setStatus] = useState<"all" | Status>("all");
  const [creator, setCreator] = useState("all");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<Item | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [youTubeUrl, setYouTubeUrl] = useState("");
  const [youTubeLoading, setYouTubeLoading] = useState(false);
  const [youTubeNotice, setYouTubeNotice] = useState("");
  const [page, setPage] = useState(1);
  const [totalResults, setTotalResults] = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (type !== "all") params.set("type", type);
      if (status !== "all") params.set("status", status);
      if (creator !== "all") params.set("creator", creator);
      params.set("limit", String(pageSize));
      params.set("offset", String((page - 1) * pageSize));
      const itemsResponse = await fetch(`/api/items?${params}`);
      if (!itemsResponse.ok) throw new Error("一覧を読み込めませんでした。再読み込みしてください。");
      const itemPayload = await readJson<{ items: Item[]; pagination?: { total?: number } }>(itemsResponse);
      setItems(itemPayload.items);
      setTotalResults(itemPayload.pagination?.total ?? itemPayload.items.length);
      const statsResponse = await fetch("/api/stats");
      if (statsResponse.ok) setStats(await readJson<Stats>(statsResponse));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "読み込みに失敗しました。");
    } finally {
      setLoading(false);
    }
  }, [query, type, status, creator, page]);

  useEffect(() => { const timer = setTimeout(refresh, query ? 180 : 0); return () => clearTimeout(timer); }, [query, refresh]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (editing || isNew)) closeEditor();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing, isNew]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const creators = useMemo(() => [...new Set(items.map((item) => item.creatorName).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja")), [items]);
  const progress = stats.total ? Math.round((stats.completed / stats.total) * 100) : 0;
  const totalPages = Math.max(1, Math.ceil(totalResults / pageSize));
  const activeEditor = isNew || editing;
  const paginationPages = [...new Set([1, page, totalPages])].sort((a, b) => a - b);
  const pagination = !loading && totalPages > 1 ? <nav className="pagination" aria-label="ページ移動"><button type="button" aria-label="前のページ" disabled={page === 1} onClick={() => setPage((current) => current - 1)}>‹</button>{paginationPages.map((value, index) => <span className="page-number" key={value}>{index > 0 && value - paginationPages[index - 1] > 1 && <i aria-hidden="true">…</i>}<button type="button" className={value === page ? "current-page" : ""} aria-current={value === page ? "page" : undefined} onClick={() => setPage(value)}>{value}</button></span>)}<button type="button" aria-label="次のページ" disabled={page === totalPages} onClick={() => setPage((current) => current + 1)}>›</button></nav> : null;

  function openNew() { setDraft(emptyDraft()); setYouTubeUrl(""); setYouTubeNotice(""); setEditing(null); setIsNew(true); setNotice(""); }
  function openEdit(item: Item) { setDraft({ ...item, links: item.links.map((link) => ({ ...link })) }); setYouTubeUrl(""); setYouTubeNotice(""); setEditing(item); setIsNew(false); setNotice(""); }
  function closeEditor() { setEditing(null); setIsNew(false); }
  function patchDraft(patch: Partial<Draft>) { setDraft((current) => ({ ...current, ...patch })); }

  async function importYouTube() {
    setYouTubeLoading(true); setYouTubeNotice("");
    try {
      const response = await fetch("/api/watch-list/youtube-preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: youTubeUrl }) });
      const data = await readJson<ApiError & { item: Partial<Draft> }>(response);
      if (!response.ok) throw new Error(data.error ?? "YouTubeから情報を取得できませんでした。");
      patchDraft(data.item);
      setYouTubeNotice("チャンネル名・タイトル・リンクを入力しました。内容を確認して保存してください。");
    } catch (error) { setYouTubeNotice(error instanceof Error ? error.message : "YouTubeから情報を取得できませんでした。"); }
    finally { setYouTubeLoading(false); }
  }

  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setNotice("");
    try {
      const response = await fetch(editing ? `/api/items/${editing.id}` : "/api/items", { method: editing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...draft, version: editing?.version }) });
      const data = await readJson<ApiError>(response);
      if (!response.ok) throw new Error(data.error ?? "保存できませんでした。");
      closeEditor(); setNotice(editing ? "変更を保存しました。" : "コンテンツを追加しました。"); await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : "保存に失敗しました。"); }
    finally { setSaving(false); }
  }

  async function updateStatus(item: Item, nextStatus: Status) {
    const watchedOn = nextStatus === "completed" ? item.watchedOn ?? new Date().toISOString().slice(0, 10) : null;
    const response = await fetch(`/api/items/${item.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...item, status: nextStatus, watchedOn, version: item.version }) });
    if (!response.ok) { const data = await readJson<ApiError>(response); setNotice(data.error ?? "更新に失敗しました。"); return; }
    setNotice(`状態を「${statusLabel[nextStatus]}」に変更しました。`); await refresh();
  }

  async function remove(item: Item) {
    if (!window.confirm(`「${item.title}」を削除しますか？`)) return;
    const response = await fetch(`/api/items/${item.id}`, { method: "DELETE" });
    if (!response.ok) { setNotice("削除に失敗しました。"); return; }
    setNotice("削除しました。必要ならバックアップから復元できます。"); await refresh();
  }

  return <main className="app-shell">
    <PortalHeader title="Watch List" active="/watch-list" />
    {notice && <p className="notice toast-notice" role="status">{notice}</p>}
    <div className="page-toolbar watch-list-toolbar">
      <section className="summary-grid" aria-label="鑑賞の状況">
        <article className="summary-card"><span>すべて</span><strong>{stats.total}</strong><small>件</small></article>
        <article className="summary-card"><span>完了</span><strong>{stats.completed}</strong><small>{progress}%</small></article>
        <article className="summary-card"><span>映像</span><strong>{stats.movie}</strong><small>件</small></article>
        <article className="summary-card"><span>読む・聴く</span><strong>{stats.text + stats.audio}</strong><small>件</small></article>
      </section>
      <button className="add-button" onClick={openNew}><span aria-hidden="true">＋</span> 追加</button>
    </div>

    <section className="library-panel" aria-labelledby="library-title">
      <div className="library-heading"><h2 id="library-title">ライブラリ</h2><span className="result-count">{loading ? "読み込み中" : `${totalResults} 件中 ${Math.min((page - 1) * pageSize + 1, totalResults || 0)}–${Math.min(page * pageSize, totalResults)}`}</span></div>
      <div className="filters">
        <label className="search"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="タイトル、人物、内容を検索" aria-label="検索" /></label>
        <label><span className="sr-only">種別</span><select value={type} onChange={(event) => { setType(event.target.value as typeof type); setPage(1); }}><option value="all">すべての種別</option>{(Object.keys(typeLabel) as ContentType[]).map((key) => <option key={key} value={key}>{typeLabel[key]}</option>)}</select></label>
        <label><span className="sr-only">状態</span><select value={status} onChange={(event) => { setStatus(event.target.value as typeof status); setPage(1); }}><option value="all">すべての状態</option>{(Object.keys(statusLabel) as Status[]).map((key) => <option key={key} value={key}>{statusLabel[key]}</option>)}</select></label>
        <label><span className="sr-only">人物・媒体</span><select value={creator} onChange={(event) => { setCreator(event.target.value); setPage(1); }}><option value="all">すべての人物・媒体</option>{creators.map((value) => <option key={value}>{value}</option>)}</select></label>
      </div>
      <div className="item-list">
        {!loading && items.length === 0 && <div className="empty-state"><strong>該当するコンテンツはありません。</strong><p>条件を変えるか、新しく追加してください。</p><button onClick={openNew}>コンテンツを追加</button></div>}
        {!loading && items.length > 0 && <div className="table-scroll"><table className="content-table">
          <thead><tr><th scope="col"><span className="sr-only">種別</span></th><th scope="col">人物・媒体</th><th scope="col">タイトル</th><th scope="col">追加日</th><th scope="col">状態</th><th scope="col">リンク</th><th scope="col">削除</th></tr></thead>
          <tbody>{items.map((item) => {
            return <tr className={item.status === "completed" ? "is-completed" : ""} key={item.id}>
              <td className="type-cell"><span className={`type-mark type-${item.contentType}`} title={typeLabel[item.contentType]} aria-label={typeLabel[item.contentType]}>{typeLabel[item.contentType].slice(0, 1)}</span></td>
              <td className="creator-cell"><strong>{item.creatorName || "—"}</strong>{item.seriesTitle && <span>{item.seriesTitle}</span>}</td>
              <td className="title-cell"><button type="button" className="title-button" onClick={() => openEdit(item)} title={`${item.title} を編集`}>{item.title}</button><p className="description" title={item.description}>{item.description || " "}</p></td>
              <td className="date-cell"><time dateTime={item.addedOn ?? undefined}>{dateLabel(item.addedOn)}</time>{item.status === "completed" && item.watchedOn && <span>完了 {dateLabel(item.watchedOn)}</span>}</td>
              <td className="status-cell"><select value={item.status} onChange={(event) => updateStatus(item, event.target.value as Status)} aria-label={`${item.title} の状態`}>{(Object.keys(statusLabel) as Status[]).map((key) => <option key={key} value={key}>{statusLabel[key]}</option>)}</select>{item.priority && <span className="priority">優先 {item.priority}</span>}</td>
              <td className="links-cell">{item.links.length > 0 ? <div className="item-links" aria-label={`${item.title} のリンク`}>{item.links.map((link, index) => <a key={`${link.id ?? link.url}-${index}`} href={link.url} target="_blank" rel="noreferrer">{link.label || `リンク ${index + 1}`} <span aria-hidden="true">↗</span></a>)}</div> : <span className="empty-cell">—</span>}</td>
              <td className="action-cell"><button className="icon-button danger" onClick={() => remove(item)}>削除</button></td>
            </tr>;
          })}</tbody>
        </table></div>}
        {pagination}
      </div>
    </section>

    {activeEditor && <div className="modal-backdrop" role="presentation" onClick={closeEditor}><section className="editor" role="dialog" aria-modal="true" aria-labelledby="editor-title" onClick={(event) => event.stopPropagation()}><div className="editor-heading"><div><p className="app-kicker">{editing ? "EDIT CONTENT" : "NEW CONTENT"}</p><h2 id="editor-title">{editing ? "コンテンツを編集" : "コンテンツを追加"}</h2></div><button className="close-button" onClick={closeEditor} aria-label="閉じる">×</button></div><form className="editor-form" onSubmit={save}>
      <section className="youtube-import" aria-labelledby="youtube-import-title"><div><strong id="youtube-import-title">YouTubeから入力</strong><p>動画URLからチャンネル名、タイトル、リンクを入力します。</p></div><div className="youtube-import-controls"><input type="url" value={youTubeUrl} onChange={(event) => setYouTubeUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=..." aria-label="YouTube動画URL" /><button type="button" onClick={importYouTube} disabled={youTubeLoading || !youTubeUrl.trim()}>{youTubeLoading ? "取得中…" : "情報を取得"}</button></div>{youTubeNotice && <p className="youtube-import-notice" role="status">{youTubeNotice}</p>}</section>
      <div className="form-grid compact first-grid"><label>種別<select value={draft.contentType} onChange={(event) => patchDraft({ contentType: event.target.value as ContentType })}>{(Object.keys(typeLabel) as ContentType[]).map((key) => <option key={key} value={key}>{typeLabel[key]}</option>)}</select></label><label>状態<select value={draft.status} onChange={(event) => patchDraft({ status: event.target.value as Status })}>{(Object.keys(statusLabel) as Status[]).map((key) => <option key={key} value={key}>{statusLabel[key]}</option>)}</select></label></div>
      <div className="form-grid"><label>人物・媒体<input value={draft.creatorName} onChange={(event) => patchDraft({ creatorName: event.target.value })} placeholder="例：NHK、ちきりん" /></label><label>番組・連載名<input value={draft.seriesTitle} onChange={(event) => patchDraft({ seriesTitle: event.target.value })} placeholder="例：WBS" /></label></div>
      <label className="title-field"><span>タイトル <b>必須</b></span><input required value={draft.title} onChange={(event) => patchDraft({ title: event.target.value })} placeholder="鑑賞したいコンテンツの名前" /></label>
      <label>内容・メモ<textarea value={draft.description} onChange={(event) => patchDraft({ description: event.target.value })} placeholder="内容、気になった理由など" rows={4} /></label>
      <div className="form-grid compact"><label>優先度<select value={draft.priority ?? ""} onChange={(event) => patchDraft({ priority: event.target.value ? Number(event.target.value) : null })}><option value="">未設定</option>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label>追加日<input type="date" value={draft.addedOn ?? ""} onChange={(event) => patchDraft({ addedOn: event.target.value || null })} /></label><label>鑑賞日<input type="date" value={draft.watchedOn ?? ""} onChange={(event) => patchDraft({ watchedOn: event.target.value || null })} /></label></div>
      <label>感想・コメント<textarea value={draft.comment} onChange={(event) => patchDraft({ comment: event.target.value })} rows={4} /></label>
      <div className="links-editor"><div><span>リンク</span><button type="button" onClick={() => patchDraft({ links: [...draft.links, { label: "", url: "", linkType: "reference" }] })}>＋ リンクを追加</button></div>{draft.links.map((link, index) => <div className="link-row" key={`${link.id ?? "new"}-${index}`}><input aria-label="リンク名" value={link.label} onChange={(event) => patchDraft({ links: draft.links.map((value, i) => i === index ? { ...value, label: event.target.value } : value) })} placeholder="表示名" /><input aria-label="URL" type="url" value={link.url} onChange={(event) => patchDraft({ links: draft.links.map((value, i) => i === index ? { ...value, url: event.target.value } : value) })} placeholder="https://" /><button type="button" onClick={() => patchDraft({ links: draft.links.filter((_, i) => i !== index) })} aria-label="リンクを削除">×</button></div>)}</div>
      <div className="editor-actions"><button type="button" className="cancel-button" onClick={closeEditor}>キャンセル</button><button className="save-button" disabled={saving}>{saving ? "保存中…" : editing ? "変更を保存" : "追加する"}</button></div>
    </form></section></div>}
  </main>;
}
