"use client";

import { useState, type FormEvent } from "react";
import { readErrorMessage, readJson } from "./lib/json";
import { MAX_BROADCASTER, MAX_EPISODE_TITLE, MAX_LINKS, MAX_LINK_LABEL, type Meta } from "./lib/openchat-meta.ts";
import type { Program } from "./lib/openchat-query.ts";
import { inferBroadcaster, siteOf } from "./lib/openchat-meta.ts";

/** 入力欄の最初のリンク: 編集済みならそれ。未編集なら、ノートのリンクカード(あれば)を入れておき、保存でそのまま残せる。 */
function initialLinks(program: Program): Meta["links"] {
  const links = program.meta.links.length > 0 ? program.meta.links : (program.linkUrl ? [{ url: program.linkUrl, label: "" }] : []);
  return (links.length > 0 ? links : [{ url: "", label: "" }]).map((link) => ({ ...link, label: link.label || siteOf(link.url)?.name || "" }));
}

/** 放送局・その日の放送タイトル・リンクの入力欄(詳細画面)。
 *  collector の同期データとは別に保存される(PUT /api/openchat/programs/:id)。 */
export function MetaForm({ program, onSaved, onCancel }: { program: Program; onSaved: (program: Program) => void; onCancel?: () => void }) {
  const [draft, setDraft] = useState<Meta>({ broadcaster: program.meta.broadcaster || inferBroadcaster(initialLinks(program).map((l) => l.url)), programName: program.meta.programName, episodeTitle: program.meta.episodeTitle, links: initialLinks(program) });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const setLink = (index: number, patch: Partial<Meta["links"][number]>) => {
    const links = draft.links.map((link, i) => {
      if (i !== index) return link;
      const next = { ...link, ...patch };
      const site = siteOf(next.url);
      return patch.url && site ? { ...next, label: site.name } : next;
    });
    setDraft({ ...draft, links, broadcaster: inferBroadcaster(links.map((link) => link.url)) || draft.broadcaster });
  };
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
    } finally {
      setSaving(false);
    }
  };
  return <form onSubmit={save}>
    {error && <p className="notice" role="alert">{error}</p>}
    <div className="form-grid chikirin-meta-grid">
      <label>放送局<input value={draft.broadcaster} maxLength={MAX_BROADCASTER} onChange={(event) => setDraft({ ...draft, broadcaster: event.target.value })} placeholder="例：NHK、テレ東" /></label>
      <label>番組名<input value={draft.programName} maxLength={MAX_EPISODE_TITLE} onChange={(event) => setDraft({ ...draft, programName: event.target.value })} placeholder="例：アナザーストーリーズ" /></label>
      <label>番組タイトル<input value={draft.episodeTitle} maxLength={MAX_EPISODE_TITLE} onChange={(event) => setDraft({ ...draft, episodeTitle: event.target.value })} placeholder="例：ダイアナ妃“最後の恋”の駆け引き" /></label>
    </div>
    <div className="links-editor"><div><span>リンク</span><button type="button" disabled={draft.links.length >= MAX_LINKS} onClick={() => setDraft({ ...draft, links: [...draft.links, { url: "", label: "" }] })}>＋ リンクを追加</button></div>
      {draft.links.map((link, index) => <div className="link-row" key={index}>
        <input type="url" value={link.url} onChange={(event) => setLink(index, { url: event.target.value })} placeholder="https://" aria-label={`リンク${index + 1}のURL`} />
        <input value={link.label} maxLength={MAX_LINK_LABEL} onChange={(event) => setLink(index, { label: event.target.value })} placeholder="表示名（省略可）" aria-label={`リンク${index + 1}の表示名`} />
        <button type="button" aria-label={`リンク${index + 1}を削除`} onClick={() => setDraft({ ...draft, links: draft.links.filter((_, i) => i !== index) })}>×</button>
      </div>)}
    </div>
    <div className="editor-actions">{onCancel && <button type="button" className="cancel-button" onClick={onCancel}>キャンセル</button>}<button className="save-button" disabled={saving}>{saving ? "保存中…" : "保存"}</button></div>
  </form>;
}
