"use client";
import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import {
  TextTubeChrome,
  Video,
  VideoForm,
  blankVideo,
  formToPayload,
} from "../text-tube-app";
import { ApiError, readJson } from "../lib/json";

/** The add / edit page for one video (/text-tube/new and
 *  /text-tube/watch/[id]/edit). This used to be a modal over the library, but
 *  the summary and the detailed script are long Markdown, a click outside the
 *  modal closed it and threw the text away, and a reload lost it too -- a page
 *  of its own fixes all three.
 *
 *  With `id`, it loads that video and its detailed script (R2) on mount; the
 *  script is only ever read here, so there is no server-rendered copy to start
 *  from. */
export function TextTubeVideoEditApp({
  id,
  fromList = false,
}: {
  id?: string;
  // Opened from a library card (?from=list) rather than the watch page:
  // cancelling and saving both go back there instead of to the watch page.
  fromList?: boolean;
}) {
  const [form, setForm] = useState<VideoForm | null>(id ? null : blankVideo),
    [saved, setSaved] = useState<VideoForm | null>(id ? null : blankVideo),
    [loadError, setLoadError] = useState(""),
    [notice, setNotice] = useState(""),
    [saving, setSaving] = useState(false),
    [createdId, setCreatedId] = useState<string | null>(null),
    [importing, setImporting] = useState(false),
    [importError, setImportError] = useState("");
  const backHref = id && !fromList ? `/text-tube/watch/${id}` : "/text-tube";

  useEffect(() => {
    if (!id) return;
    let alive = true;
    (async () => {
      try {
        const [videoResponse, docResponse] = await Promise.all([
          fetch(`/api/text-tube/videos/${id}`),
          fetch(`/api/text-tube/videos/${id}/document`),
        ]);
        // Checked before readJson(): an unhandled exception on the API side
        // comes back as a non-2xx response with an empty body, and parsing
        // that throws "Unexpected end of JSON input" rather than a usable
        // message.
        if (!videoResponse.ok) {
          const body = (await videoResponse.json().catch(() => null)) as ApiError | null;
          throw new Error(body?.error || "動画を読み込めませんでした。");
        }
        // Not falling back to "" here: saving would then overwrite a script
        // that exists but failed to load with an empty one.
        if (!docResponse.ok) throw new Error("本文を読み込めませんでした。");
        const { video } = await readJson<{ video: Video }>(videoResponse);
        const loaded = videoToForm(video, await docResponse.text());
        if (!alive) return;
        setForm(loaded);
        setSaved(loaded);
      } catch (error) {
        if (alive) setLoadError(error instanceof Error ? error.message : "動画を読み込めませんでした。");
      }
    })();
    return () => { alive = false; };
  }, [id]);

  // Leaving with unsaved text (closing the tab, reloading, typing a URL)
  // asks first. Links inside the app are covered by the cancel link's own
  // confirm below.
  const dirty = form !== null && saved !== null && JSON.stringify(form) !== JSON.stringify(saved);
  // Set right before the page navigates away after a successful save: that
  // navigation happens before the re-render that would drop the listener.
  const leaving = useRef(false);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { if (!leaving.current) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form || saving) return;
    setSaving(true);
    setNotice("");
    const existingId = id ?? createdId;
    try {
      const r = await fetch(existingId ? `/api/text-tube/videos/${existingId}` : "/api/text-tube/videos", {
        method: existingId ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(formToPayload(form)),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as ApiError | null;
        throw new Error(body?.error ?? "保存できませんでした。");
      }
      const videoId = existingId ?? (await readJson<{ id: string }>(r)).id;
      // A new video with no script has nothing to store; an existing one
      // always writes it, so clearing the textarea clears the script.
      if (existingId || form.detailedScript) {
        const docResponse = await fetch(`/api/text-tube/videos/${videoId}/document`, {
          method: "POST",
          body: form.detailedScript,
        });
        if (!docResponse.ok) {
          // The video itself is saved by now; stay on this page with the
          // text still in the form so the script is not lost. A new video
          // remembers its id, so saving again updates it instead of adding
          // a second copy.
          const body = (await docResponse.json().catch(() => null)) as ApiError | null;
          setCreatedId(videoId);
          throw new Error(`動画は保存しましたが、本文は保存できませんでした: ${body?.error ?? "不明なエラー"}`);
        }
      }
      leaving.current = true;
      // A full page load rather than a client-side navigation: the page
      // could otherwise come back from the client router cache showing the
      // video as it was before this save (the same reason
      // chikirin-detail.tsx goes back this way). Back to the library when
      // that is where the edit started; otherwise (the watch page, or a new
      // video) to the video itself.
      window.location.href = fromList ? "/text-tube" : `/text-tube/watch/${videoId}`;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "保存できませんでした。");
      setSaving(false);
    }
  }

  async function importYouTube() {
    if (!form) return;
    setImporting(true);
    setImportError("");
    try {
      const r = await fetch("/api/text-tube/youtube-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: form.originalUrl }),
      });
      if (!r.ok) {
        // Prefer the API's own error message when the response has one; an
        // unhandled exception on the API side comes back with an empty body.
        const body = (await r.json().catch(() => null)) as ApiError | null;
        throw new Error(body?.error || "動画情報を取得できませんでした。");
      }
      const d = await readJson<{ preview?: Partial<VideoForm>; captionNotice?: string }>(r);
      setForm((current) => (current ? { ...current, ...d.preview } : current));
      if (d.captionNotice) setImportError(`字幕: ${d.captionNotice}`);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "動画情報を取得できませんでした。");
    } finally {
      setImporting(false);
    }
  }

  const cancel = (event: React.MouseEvent) => {
    if (dirty && !confirm("保存していない変更があります。破棄して戻りますか？")) event.preventDefault();
  };

  if (loadError)
    return (
      <TextTubeChrome>
        <div className="tt-empty">
          {loadError}
          <Link href="/text-tube" prefetch={false}>一覧に戻る</Link>
        </div>
      </TextTubeChrome>
    );
  if (!form)
    return (
      <TextTubeChrome>
        <div className="tt-loading">読み込み中…</div>
      </TextTubeChrome>
    );

  const set =
    (key: keyof VideoForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm({
        ...form,
        [key]: key === "viewCount" ? Number(e.target.value) : e.target.value,
      });
  return (
    <TextTubeChrome>
      <section className="tt-editor tt-editor-page" aria-labelledby="texttube-editor-title">
        <div className="tt-editor-head">
          <div>
            <p className="tt-kicker">TEXTTUBE</p>
            <h2 id="texttube-editor-title">{id ? "動画を編集" : "動画を追加"}</h2>
          </div>
        </div>
        {notice && <div className="tt-notice" role="alert">{notice}</div>}
        <form onSubmit={submit}>
          <div className="tt-youtube-import">
            <label>
              {" "}
              YouTube URL{" "}
              <input
                type="url"
                value={form.originalUrl}
                onChange={set("originalUrl")}
                placeholder="https://www.youtube.com/watch?v=..."
              />{" "}
            </label>
            <button type="button" onClick={importYouTube} disabled={importing}>
              {importing ? "取得中…" : "動画情報を取得"}
            </button>
          </div>
          {importError && <p className="tt-import-error">{importError}</p>}
          <label className="tt-title-field">
            タイトル <b>必須</b>
            <input required value={form.title} onChange={set("title")} />
          </label>
          <div className="tt-form-grid">
            <label>
              チャンネル
              <input value={form.channelName} onChange={set("channelName")} />
            </label>
            <label>
              サムネイルURL
              <input type="url" value={form.thumbnailUrl} onChange={set("thumbnailUrl")} />
            </label>
            <label>
              チャンネル画像URL
              <input type="url" value={form.channelThumbnailUrl} onChange={set("channelThumbnailUrl")} />
            </label>
            <label>
              公開日
              <input type="date" value={form.publishedAt?.slice(0, 10)} onChange={set("publishedAt")} />
            </label>
            <label>
              動画時間
              <input value={form.duration} onChange={set("duration")} />
            </label>
            <label>
              閲覧数
              <input type="number" value={form.viewCount} onChange={set("viewCount")} />
            </label>
          </div>
          <label>
            要約
            <textarea rows={12} value={form.summary} onChange={set("summary")} />
          </label>
          <label>
            詳細スクリプト（Markdown）
            <textarea rows={24} value={form.detailedScript} onChange={set("detailedScript")} />
          </label>
          <div className="tt-editor-actions">
            <Link href={backHref} prefetch={false} onClick={cancel}>
              キャンセル
            </Link>
            <button className="primary" disabled={saving}>
              {saving ? "保存中…" : id ? "保存する" : "追加する"}
            </button>
          </div>
        </form>
      </section>
    </TextTubeChrome>
  );
}

function videoToForm(video: Video, detailedScript: string): VideoForm {
  return {
    title: video.title,
    channelName: video.channel_name,
    originalUrl: video.original_url,
    thumbnailUrl: video.thumbnail_url,
    channelThumbnailUrl: video.channel_thumbnail_url ?? "",
    summary: video.summary,
    detailedScript,
    publishedAt: video.published_at ?? "",
    viewCount: video.view_count,
    duration: video.duration,
  };
}
