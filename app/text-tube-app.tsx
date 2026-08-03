"use client";
import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { PortalHeader } from "./portal-nav";

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

function TextTubeIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className="tt-sidebar-icon" aria-hidden="true">
      {children}
    </span>
  );
}

function TextTubeOriginalSidebar({ active }: { active: string }) {
  const items = [
    ["/text-tube", "⌂", "ホーム"],
    ["/text-tube", "▣", "ライブラリ"],
    ["/text-tube/studio", "✎", "Studio"],
    ["/watch-list", "◷", "Watch List"],
    ["/manage-asset", "▥", "Manage Asset"],
  ];
  return (
    <aside className="tt-sidebar tt-embedded-sidebar">
      <div className="tt-sidebar-menu">
        {items.map(([href, icon, label]) => (
          <Link
            key={label}
            className={active === href ? "active" : ""}
            href={href}
          >
            <TextTubeIcon>{icon}</TextTubeIcon>
            <b>{label}</b>
          </Link>
        ))}
      </div>
      <div className="tt-side-rule" />
      <div className="tt-sidebar-note">
        <small>登録チャンネル</small>
        <p>個人用TextTubeライブラリ</p>
      </div>
    </aside>
  );
}

export function TextTubeChrome({
  children,
  active = "/text-tube",
}: {
  children: React.ReactNode;
  active?: string;
}) {
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
      >
        <nav className="texttube-section-nav" aria-label="TextTube メニュー">
          <Link
            className={active === "/text-tube" ? "active" : ""}
            href="/text-tube"
          >
            ライブラリ
          </Link>
          <Link
            className={active === "/text-tube/studio" ? "active" : ""}
            href="/text-tube/studio"
          >
            Studio
          </Link>
        </nav>
      </PortalHeader>
      <div className="tt-original-frame">
        <div className="tt-original-body">
          <TextTubeOriginalSidebar active={active} />
          <div className="tt-main">{children}</div>
        </div>
      </div>
    </main>
  );
}
export function TextTubeApp() {
  const [videos, setVideos] = useState<Video[]>([]),
    [q, setQ] = useState(""),
    [channel, setChannel] = useState("all"),
    [sort, setSort] = useState("created_at-desc"),
    [open, setOpen] = useState(false),
    [notice, setNotice] = useState(""),
    [form, setForm] = useState<VideoForm>(blankVideo);
  async function load() {
    const r = await fetch(`/api/text-tube/videos?q=${encodeURIComponent(q)}`);
    if (r.ok) setVideos((await r.json()).videos);
  }
  useEffect(() => {
    const t = setTimeout(load, q ? 180 : 0);
    return () => clearTimeout(t);
  }, [q]);
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
    const r = await fetch("/api/text-tube/videos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(formToPayload(form)),
    });
    const d = await r.json();
    if (!r.ok) {
      setNotice(d.error ?? "保存できませんでした。");
      return;
    }
    if (form.detailedScript)
      await fetch(`/api/text-tube/videos/${d.id}/document`, {
        method: "POST",
        body: form.detailedScript,
      });
    setForm(blankVideo);
    setOpen(false);
    setNotice("動画を追加しました。");
    load();
  }
  return (
    <TextTubeChrome>
      <div className="tt-page-head">
        <div>
          <p className="tt-kicker">HOME</p>
          <h1>おすすめの要約</h1>
        </div>
        <div className="tt-head-controls">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="タイトル・チャンネルを検索"
          />
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
          <Link
            className="tt-video-card"
            href={`/text-tube/watch/${v.id}`}
            key={v.id}
          >
            <div className="tt-thumb">
              {v.thumbnail_url ? (
                <img src={v.thumbnail_url} alt="" />
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
                {(v.channel_name || "T").slice(0, 1)}
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
        ))}
        {!shown.length && (
          <div className="tt-empty">
            該当する動画がありません。
            <Link href="/text-tube/studio">Studioで作成する</Link>
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
      const d = await r.json();
      if (!r.ok) throw Error(d.error);
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
  return (
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
            <p className="tt-kicker">TEXTTUBE STUDIO</p>
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
    </div>
  );
}
