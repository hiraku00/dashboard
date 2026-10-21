"use client";
import Link from "next/link";
import Image from "next/image";
import { createPortal } from "react-dom";
import { FormEvent, useCallback, useMemo, useState } from "react";
import { PortalHeader } from "./portal-nav";
import { ApiError, readJson } from "./lib/json";
import { MAX_LIKE_TERM_BYTES, truncateUtf8Bytes, utf8ByteLength } from "./lib/sql-text.ts";
import { useSearchReload } from "./lib/use-search-reload";
import { useLatestRequest } from "./lib/use-latest-request";

export type Video = {
  id: string;
  title: string;
  channel_name: string;
  thumbnail_url: string;
  original_url: string;
  summary: string;
  published_at: string | null;
  view_count: number;
  duration: string;
  created_at: string;
  updated_at: string;
  detailed_script_object_key?: string | null;
  channel_thumbnail_url?: string;
};
export type VideoForm = {
  title: string;
  channelName: string;
  originalUrl: string;
  thumbnailUrl: string;
  channelThumbnailUrl: string;
  summary: string;
  detailedScript: string;
  publishedAt: string;
  viewCount: number;
  duration: string;
};
export const blankVideo: VideoForm = {
  title: "",
  channelName: "",
  originalUrl: "",
  thumbnailUrl: "",
  channelThumbnailUrl: "",
  summary: "",
  detailedScript: "",
  publishedAt: "",
  viewCount: 0,
  duration: "",
};
const date = (value?: string | null) =>
  value ? new Date(value).toLocaleDateString("ja-JP") : "—";
const views = (value: number) =>
  value >= 10000
    ? `${(value / 10000).toFixed(1)}万`
    : value.toLocaleString("ja-JP");

export function TextTubeChrome({ children }: { children: React.ReactNode }) {
  return (
    <main className="portal-shell texttube-workspace">
      <PortalHeader
        title={
          <>
            <span className="texttube-logo-mark" aria-hidden="true">
              ▶
            </span>
            TextTube
          </>
        }
        active="/text-tube"
      />
      <div className="tt-original-frame">
        <div className="tt-original-body">
          <div className="tt-main">{children}</div>
        </div>
      </div>
      {/* VideoEditor's modal portals here rather than into document.body:
          this div is a sibling of .tt-original-frame (so it isn't clipped
          by that frame's overflow:hidden), but -- unlike document.body --
          it is still a descendant of .texttube-workspace, so the
          `.texttube-workspace .tt-editor` / `.tt-youtube-import` rules
          below that give the modal its light portal theme (as opposed to
          the dark standalone-app look those classes fall back to outside
          this scope) still match it. See VideoEditor's own comment. */}
      <div id="tt-modal-root" />
    </main>
  );
}
/** Editing and deleting a video, shared by the library cards and the watch
 *  page (this used to live in a separate Studio page, whose only job was these
 *  two buttons). `editor` is the modal to render while editing; it portals into
 *  TextTubeChrome's #tt-modal-root, so the caller just has to render it. */
export function useVideoActions({
  onSaved,
  onDeleted,
  onNotice,
}: {
  onSaved: () => void;
  onDeleted: (id: string) => void;
  onNotice: (message: string) => void;
}) {
  const [editing, setEditing] = useState<{ id: string; form: VideoForm } | null>(null);
  async function edit(id: string) {
    try {
      const [videoResponse, doc] = await Promise.all([
        fetch(`/api/text-tube/videos/${id}`),
        fetch(`/api/text-tube/videos/${id}/document`).then((r) =>
          r.ok ? r.text() : "",
        ),
      ]);
      // Checked before readJson(): an unhandled exception on the API side
      // comes back as a non-2xx response with an empty body, and parsing
      // that throws "Unexpected end of JSON input" rather than a usable
      // message.
      if (!videoResponse.ok) throw new Error("動画を読み込めませんでした。");
      const { video } = await readJson<{ video: Video }>(videoResponse);
      setEditing({ id, form: videoToForm(video, doc) });
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "動画を読み込めませんでした。");
    }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    try {
      const r = await fetch(`/api/text-tube/videos/${editing.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(formToPayload(editing.form)),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as ApiError | null;
        onNotice(body?.error ?? "更新できませんでした。");
        return;
      }
      const docResponse = await fetch(`/api/text-tube/videos/${editing.id}/document`, {
        method: "POST",
        body: editing.form.detailedScript,
      });
      setEditing(null);
      if (docResponse.ok) onNotice("保存しました。");
      else {
        const body = (await docResponse.json().catch(() => null)) as ApiError | null;
        onNotice(`保存しました。(本文は保存できませんでした: ${body?.error ?? "不明なエラー"})`);
      }
      onSaved();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "更新できませんでした。");
    }
  }
  async function remove(video: Pick<Video, "id" | "title">) {
    if (!confirm(`「${video.title}」を削除しますか？`)) return;
    try {
      const r = await fetch(`/api/text-tube/videos/${video.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("削除できませんでした。");
      onNotice("削除しました。");
      onDeleted(video.id);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "削除できませんでした。");
    }
  }
  const editor = editing && (
    <VideoEditor
      title="動画を編集"
      value={editing.form}
      onChange={(form) => setEditing({ ...editing, form })}
      onClose={() => setEditing(null)}
      onSubmit={save}
      submitLabel="保存する"
    />
  );
  return { edit, remove, editor };
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
export function TextTubeApp({
  initialVideos = null,
}: {
  // Passed by app/text-tube/page.tsx (a Server Component) after fetching
  // this directly from D1 -- see app/lib/queries/text-tube.ts. It calls
  // listVideos({}) with no query, i.e. exactly the default filter state
  // below (q=""), so skipping this component's own initial fetch when this
  // is present does not skip past a filtered view the server never
  // rendered. Optional so this component still works exactly as before
  // (client-side fetch on mount) if ever rendered without it.
  initialVideos?: Video[] | null;
} = {}) {
  const [videos, setVideos] = useState<Video[]>(initialVideos ?? []),
    [q, setQ] = useState(""),
    [channel, setChannel] = useState("all"),
    [sort, setSort] = useState("created_at-desc"),
    [open, setOpen] = useState(false),
    [notice, setNotice] = useState(""),
    [form, setForm] = useState<VideoForm>(blankVideo);
  const { begin, isCurrent } = useLatestRequest();
  const load = useCallback(async () => {
    const requestId = begin();
    const r = await fetch(`/api/text-tube/videos?q=${encodeURIComponent(q)}`);
    if (!r.ok) return;
    const videos = (await readJson<{ videos: Video[] }>(r)).videos;
    if (!isCurrent(requestId)) return;
    setVideos(videos);
  }, [q, begin, isCurrent]);
  // Skips exactly the mount-time reload when the server already rendered
  // this same default (q="") view. See app/lib/use-search-reload.ts.
  useSearchReload(load, q, Boolean(initialVideos));
  const actions = useVideoActions({
    onSaved: load,
    onDeleted: (id) => setVideos((current) => current.filter((v) => v.id !== id)),
    onNotice: setNotice,
  });
  const channels = useMemo(
    () =>
      Array.from(
        new Set(videos.map((v) => v.channel_name).filter(Boolean)),
      ).sort(),
    [videos],
  );
  const shown = useMemo(
    () =>
      videos
        .filter((v) => channel === "all" || v.channel_name === channel)
        .sort((a, b) =>
          sort === "title-asc"
            ? a.title.localeCompare(b.title)
            : sort === "view_count-desc"
              ? b.view_count - a.view_count
              : sort === "created_at-asc"
                ? a.created_at.localeCompare(b.created_at)
                : b.created_at.localeCompare(a.created_at),
        ),
    [videos, channel, sort],
  );
  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await fetch("/api/text-tube/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(formToPayload(form)),
      });
      if (!r.ok) {
        // Checked before readJson(): an unhandled exception on the API
        // side comes back with an empty body, and readJson()'s
        // response.json() on that throws "Unexpected end of JSON input"
        // rather than a usable message -- this whole function previously
        // had no try/catch at all, so that (or any other failure) surfaced
        // only as an unhandled promise rejection in the console.
        const body = (await r.json().catch(() => null)) as ApiError | null;
        setNotice(body?.error ?? "保存できませんでした。");
        return;
      }
      const d = await readJson<{ id: string }>(r);
      let documentNotice = "";
      if (form.detailedScript) {
        const docResponse = await fetch(
          `/api/text-tube/videos/${d.id}/document`,
          { method: "POST", body: form.detailedScript },
        );
        if (!docResponse.ok) {
          // The video itself was created successfully above -- only the
          // body text failed to save. Surface that distinctly rather than
          // silently dropping it: previously this fetch's result was never
          // checked, so a failure here left "動画を追加しました。" showing
          // for a video with no script attached.
          const body = (await docResponse.json().catch(() => null)) as ApiError | null;
          documentNotice = `(本文は保存できませんでした: ${body?.error ?? "不明なエラー"})`;
        }
      }
      setForm(blankVideo);
      setOpen(false);
      setNotice(
        documentNotice
          ? `動画を追加しました。${documentNotice}`
          : "動画を追加しました。",
      );
      load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "保存できませんでした。");
    }
  }
  return (
    <TextTubeChrome>
      <div className="tt-page-head">
        <div>
          <p className="tt-kicker">HOME</p>
          <h1>おすすめの要約</h1>
        </div>
        <div className="tt-head-controls">
          <span className="tt-query-field">
            <input
              value={q}
              onChange={(e) => setQ(truncateUtf8Bytes(e.target.value, MAX_LIKE_TERM_BYTES))}
              placeholder="タイトル・チャンネルを検索"
              title={`検索語は${MAX_LIKE_TERM_BYTES}バイトまでです（半角英数字は1文字1バイト、日本語などの全角文字は1文字3バイト）`}
            />
            {q && <span className="tt-query-limit" aria-hidden="true">{utf8ByteLength(q)}/{MAX_LIKE_TERM_BYTES}</span>}
          </span>
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="created_at-desc">最新順（記事作成日）</option>
            <option value="view_count-desc">人気順（閲覧数）</option>
            <option value="created_at-asc">古い順</option>
            <option value="title-asc">タイトル順</option>
          </select>
          <button className="tt-create" onClick={() => setOpen(true)}>
            ＋ 動画を追加
          </button>
        </div>
      </div>
      {notice && <div className="tt-notice">{notice}</div>}
      <div className="tt-channel-filter">
        <span>{shown.length}本の要約</span>
        <select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="all">すべてのチャンネル</option>
          {channels.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      <div className="tt-video-grid">
        {shown.map((v) => (
          <article className="tt-video-card" key={v.id}>
            {/* prefetch={false}: this page can render up to 100 of these
                cards, and /text-tube/watch/[id] is a Server Component reading
                D1 -- leaving prefetch on would mean simply scrolling this grid
                into view reads D1 once per visible card. */}
            <Link
              className="tt-video-link"
              href={`/text-tube/watch/${v.id}`}
              prefetch={false}
            >
              <div className="tt-thumb">
                {v.thumbnail_url ? (
                  <Image
                    src={v.thumbnail_url}
                    alt=""
                    fill
                    sizes="(max-width: 460px) 100vw, (max-width: 1000px) 50vw, 25vw"
                    unoptimized
                  />
                ) : (
                  <span>
                    TEXT
                    <br />
                    TUBE
                  </span>
                )}
                {v.duration && <b>{v.duration}</b>}
              </div>
              <div className="tt-video-info">
                <span className="tt-channel-avatar">
                  {v.channel_thumbnail_url ? (
                    <Image
                      src={v.channel_thumbnail_url}
                      alt=""
                      fill
                      sizes="34px"
                      unoptimized
                    />
                  ) : (
                    (v.channel_name || "T").slice(0, 1)
                  )}
                </span>
                <div>
                  <h3>{v.title}</h3>
                  <p>{v.channel_name || "チャンネル未設定"}</p>
                  <small>
                    {views(v.view_count)} 閲覧 · 記事作成日 {date(v.created_at)}
                    <br />
                    動画公開日 {date(v.published_at)}
                  </small>
                </div>
              </div>
            </Link>
            <div className="tt-card-actions">
              <button type="button" onClick={() => actions.edit(v.id)}>
                編集
              </button>
              <button type="button" className="danger" onClick={() => actions.remove(v)}>
                削除
              </button>
            </div>
          </article>
        ))}
        {!shown.length && (
          <div className="tt-empty">
            該当する動画がありません。
          </div>
        )}
      </div>
      {open && (
        <VideoEditor
          title="動画を追加"
          value={form}
          onChange={setForm}
          onClose={() => setOpen(false)}
          onSubmit={create}
          submitLabel="追加する"
        />
      )}
      {actions.editor}
    </TextTubeChrome>
  );
}
export function formToPayload(form: VideoForm) {
  return {
    title: form.title,
    channelName: form.channelName,
    originalUrl: form.originalUrl,
    thumbnailUrl: form.thumbnailUrl,
    channelThumbnailUrl: form.channelThumbnailUrl,
    summary: form.summary,
    publishedAt: form.publishedAt,
    viewCount: form.viewCount,
    duration: form.duration,
  };
}
export function VideoEditor({
  title,
  value,
  onChange,
  onClose,
  onSubmit,
  submitLabel,
}: {
  title: string;
  value: VideoForm;
  onChange: (v: VideoForm) => void;
  onClose: () => void;
  onSubmit: (e: FormEvent) => void;
  submitLabel: string;
}) {
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const set =
    (key: keyof VideoForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange({
        ...value,
        [key]: key === "viewCount" ? Number(e.target.value) : e.target.value,
      });
  async function importYouTube() {
    setImporting(true);
    setImportError("");
    try {
      const r = await fetch("/api/text-tube/youtube-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: value.originalUrl }),
      });
      if (!r.ok) {
        // Prefer the API's own error message when the response actually
        // has one; an unhandled exception on the API side comes back with
        // an empty body instead, and readJson()'s response.json() on that
        // throws "Unexpected end of JSON input" -- catching that generic
        // parser message here (rather than letting it fall through to the
        // catch block below and get shown verbatim) is the fix.
        const body = (await r.json().catch(() => null)) as ApiError | null;
        throw new Error(body?.error || "動画情報を取得できませんでした。");
      }
      const d = await readJson<{ preview?: Partial<VideoForm>; captionNotice?: string }>(r);
      onChange({ ...value, ...d.preview });
      if (d.captionNotice) setImportError(`字幕: ${d.captionNotice}`);
    } catch (e) {
      setImportError(
        e instanceof Error ? e.message : "動画情報を取得できませんでした。",
      );
    } finally {
      setImporting(false);
    }
  }
  // Rendered via a portal into TextTubeChrome's #tt-modal-root, not in
  // place: TextTubeChrome wraps this in `.tt-original-frame`, which has
  // `overflow:hidden` for its own rounded-corner card look, and that clips
  // a position:fixed descendant (this modal's backdrop) to the frame's own
  // box instead of the viewport -- so without the portal, the top of this
  // dialog renders hidden above wherever the frame happens to start on the
  // page.
  //
  // The portal target is #tt-modal-root and not document.body: it still
  // has to be a descendant of `.texttube-workspace` (TextTubeChrome's own
  // top-level element), because the modal's light portal theme --
  // `.texttube-workspace .tt-editor`, `.texttube-workspace
  // .tt-youtube-import` and friends in app/globals.css -- is written as a
  // descendant selector, not a self-contained class. Portaling straight to
  // document.body escapes that scope too, along with the clipping frame,
  // and silently drops back to the dark standalone-app styling those rules
  // override (or, for `.tt-youtube-import`, which has no unscoped
  // fallback at all, to unstyled browser defaults -- an invisible "動画情報
  // を取得" button was exactly that regression).
  //
  // `open` (the only state this ever mounts under) starts false, so this
  // never has to render during SSR and #tt-modal-root is always present by
  // the time it does (TextTubeChrome renders it unconditionally, and
  // VideoEditor is always a descendant of TextTubeChrome -- see its own
  // comment). The `?? document.body` fallback is defensive only.
  const portalTarget = document.getElementById("tt-modal-root") ?? document.body;
  return createPortal(
    <div className="tt-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="tt-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="texttube-editor-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="tt-editor-head">
          <div>
            <p className="tt-kicker">TEXTTUBE</p>
            <h2 id="texttube-editor-title">{title}</h2>
          </div>
          <button onClick={onClose}>×</button>
        </div>
        <form onSubmit={onSubmit}>
          <div className="tt-youtube-import">
            <label>
              {" "}
              YouTube URL{" "}
              <input
                type="url"
                value={value.originalUrl}
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
            <input required value={value.title} onChange={set("title")} />
          </label>
          <div className="tt-form-grid">
            <label>
              チャンネル
              <input value={value.channelName} onChange={set("channelName")} />
            </label>
            <label>
              サムネイルURL
              <input
                type="url"
                value={value.thumbnailUrl}
                onChange={set("thumbnailUrl")}
              />
            </label>
            <label>
              チャンネル画像URL
              <input
                type="url"
                value={value.channelThumbnailUrl}
                onChange={set("channelThumbnailUrl")}
              />
            </label>
            <label>
              公開日
              <input
                type="date"
                value={value.publishedAt?.slice(0, 10)}
                onChange={set("publishedAt")}
              />
            </label>
            <label>
              動画時間
              <input value={value.duration} onChange={set("duration")} />
            </label>
            <label>
              閲覧数
              <input
                type="number"
                value={value.viewCount}
                onChange={set("viewCount")}
              />
            </label>
          </div>
          <label>
            要約
            <textarea
              rows={7}
              value={value.summary}
              onChange={set("summary")}
            />
          </label>
          <label>
            詳細スクリプト（Markdown）
            <textarea
              rows={14}
              value={value.detailedScript}
              onChange={set("detailedScript")}
            />
          </label>
          <div className="tt-editor-actions">
            <button type="button" onClick={onClose}>
              キャンセル
            </button>
            <button className="primary">{submitLabel}</button>
          </div>
        </form>
      </section>
    </div>,
    portalTarget,
  );
}
