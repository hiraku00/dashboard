"use client";
import Link from "next/link";
import Image from "next/image";
import { useCallback, useMemo, useState } from "react";
import { PortalHeader } from "./portal-nav";
import { readJson } from "./lib/json";
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
    </main>
  );
}
/** Deleting a video, shared by the library cards and the watch page. Editing
 *  is its own page (/text-tube/watch/[id]/edit -- see
 *  app/text-tube/video-edit-app.tsx), so the cards and the watch page only
 *  link to it. */
export function useDeleteVideo({
  onDeleted,
  onNotice,
}: {
  onDeleted: (id: string) => void;
  onNotice: (message: string) => void;
}) {
  return async function remove(video: Pick<Video, "id" | "title">) {
    if (!confirm(`「${video.title}」を削除しますか？`)) return;
    try {
      const r = await fetch(`/api/text-tube/videos/${video.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("削除できませんでした。");
      onNotice("削除しました。");
      onDeleted(video.id);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "削除できませんでした。");
    }
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
    [notice, setNotice] = useState("");
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
  const remove = useDeleteVideo({
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
          <Link className="tt-create" href="/text-tube/new" prefetch={false}>
            ＋ 動画を追加
          </Link>
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
              <Link href={`/text-tube/watch/${v.id}/edit?from=list`} prefetch={false}>
                編集
              </Link>
              <button type="button" className="danger" onClick={() => remove(v)}>
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
