"use client";

import { useState, type FormEvent } from "react";
import { readErrorMessage, readJson } from "./lib/json";
import { MAX_BODY_CHARS } from "./lib/openchat-input.ts";
import type { Program } from "./lib/openchat-query.ts";
import { Body } from "./chikirin-body";

/** 投稿の本文。「編集」でその場のテキスト欄になり、OCRの読み間違いを直せる(PATCH /api/openchat/programs/:id)。
 *  target が "note" ならスレッドの本文、コメントならそのコメントのid。 */
export function EditableBody({ noteId, text, target, onSaved }: { noteId: string; text: string; target: "note" | { commentId: string }; onSaved: (program: Program) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = target === "note" ? { noteBody: draft } : { comments: [{ id: target.commentId, bodyText: draft }] };
      const response = await fetch(`/api/openchat/programs/${encodeURIComponent(noteId)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, "保存できませんでした。"));
      onSaved((await readJson<{ program: Program }>(response)).program);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存できませんでした。");
    } finally {
      setSaving(false);
    }
  };
  if (!editing) return <>
    <Body text={text} full />
    <button type="button" className="chikirin-toggle" onClick={() => { setDraft(text); setError(""); setEditing(true); }}>編集</button>
  </>;
  return <form className="chikirin-text-edit" onSubmit={save}>
    {error && <p className="notice" role="alert">{error}</p>}
    <textarea value={draft} maxLength={MAX_BODY_CHARS} rows={Math.min(24, Math.max(4, draft.split("\n").length + 1))} onChange={(event) => setDraft(event.target.value)} aria-label="本文" />
    <div className="editor-actions">
      <button type="button" className="cancel-button" onClick={() => setEditing(false)}>キャンセル</button>
      <button className="save-button" disabled={saving || !draft.trim()}>{saving ? "保存中…" : "保存"}</button>
    </div>
  </form>;
}
