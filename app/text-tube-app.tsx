"use client";
import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PortalHeader } from "./portal-nav";
import { readJson } from "./lib/json";
import { MAX_LIKE_TERM_BYTES, truncateUtf8Bytes, utf8ByteLength } from "./lib/sql-text.ts";
import { useSearchReload } from "./lib/use-search-reload";
import { useLatestRequest } from "./lib/use-latest-request";
import { DEFAULT_SORT, listViewQuery, type ListView } from "./lib/text-tube-list-view.ts";

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
  /** 読み終えた日時(ISO)。未読は null。 */
  read_at?: string | null;
};
/** 一覧のカードが持つ行。要約は一覧のAPIが返さない（app/lib/queries/text-tube.ts の VideoListItem）。 */
export type VideoListItem = Omit<Video, "summary">;
/** 最後に見ていた一覧の URL（絞り込み込み）を覚えておく sessionStorage のキー。 */
export const LIST_URL_KEY = "tt-list-url";
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
      // 404 は、ほかの画面でもう削除されていたとき。結果は同じなので、一覧からも外す。
      if (!r.ok && r.status !== 404) throw new Error("削除できませんでした。");
      onNotice("削除しました。");
      onDeleted(video.id);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "削除できませんでした。");
    }
  };
}
export function TextTubeApp({
  initialVideos = null,
  initialHasMore = false,
  initialView,
}: {
  // Passed by app/text-tube/page.tsx (a Server Component) after fetching
  // this directly from D1 -- see app/lib/queries/text-tube.ts. It calls
  // listVideos({}) with no query, i.e. exactly the default filter state
  // below (q=""), so skipping this component's own initial fetch when this
  // is present does not skip past a filtered view the server never
  // rendered. Optional so this component still works exactly as before
  // (client-side fetch on mount) if ever rendered without it.
  initialVideos?: VideoListItem[] | null;
  /** サーバーが返した先頭ページの先に、まだ動画があるか。 */
  initialHasMore?: boolean;
  /** URL のクエリから読んだ一覧の状態。サーバーは同じ q と unread で initialVideos を読んでいる。 */
  initialView?: ListView;
} = {}) {
  const [videos, setVideos] = useState<VideoListItem[]>(initialVideos ?? []),
    [hasMore, setHasMore] = useState(initialHasMore),
    [loadingMore, setLoadingMore] = useState(false),
    [q, setQ] = useState(initialView?.q ?? ""),
    [channel, setChannel] = useState(initialView?.channel ?? "all"),
    [sort, setSort] = useState(initialView?.sort ?? DEFAULT_SORT),
    [unread, setUnread] = useState(initialView?.unread ?? false),
    [notice, setNotice] = useState("");
  // 一覧の状態を URL に残す。記事を開いて「戻る」で帰ってきたときや、再読み込みしたときに、
  // 検索語・並び順・チャンネル・未読のみが元のままになる。履歴は増やさない（replaceState）。
  useEffect(() => {
    const next = `${window.location.pathname}${listViewQuery({ q, sort, channel, unread })}`;
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(window.history.state, "", next);
    // 記事ページの「一覧に戻る」が、この状態のままの一覧へ戻れるように覚えておく。
    try { window.sessionStorage.setItem(LIST_URL_KEY, next); } catch { /* 保存できなくても、既定の一覧へ戻るだけ */ }
  }, [q, sort, channel, unread]);
  const listQuery = `q=${encodeURIComponent(q)}${unread ? "&unread=1" : ""}`;
  const { begin, isCurrent } = useLatestRequest();
  const load = useCallback(async () => {
    const requestId = begin();
    const r = await fetch(`/api/text-tube/videos?${listQuery}`);
    if (!r.ok) return;
    const body = await readJson<{ videos: VideoListItem[]; hasMore?: boolean }>(r);
    if (!isCurrent(requestId)) return;
    setVideos(body.videos);
    setHasMore(Boolean(body.hasMore));
  }, [listQuery, begin, isCurrent]);
  // 続きの読み込み。offset は「いま持っている本数」-- 削除した動画はサーバー側でも1本減っているので、
  // 持っている本数がそのまま次の位置になる。読み込みの間に検索語が変わったら、結果は捨てる（load と同じ）。
  // 間に動画が追加されて位置がずれても同じカードが二重に出ないよう、id で重なりを除く。
  const loadMore = useCallback(async () => {
    const requestId = begin();
    setLoadingMore(true);
    try {
      const r = await fetch(`/api/text-tube/videos?${listQuery}&offset=${videos.length}`);
      if (!r.ok) throw new Error("続きを読み込めませんでした。");
      const body = await readJson<{ videos: VideoListItem[]; hasMore?: boolean }>(r);
      if (!isCurrent(requestId)) return;
      setVideos((current) => {
        const known = new Set(current.map((v) => v.id));
        return [...current, ...body.videos.filter((v) => !known.has(v.id))];
      });
      setHasMore(Boolean(body.hasMore));
    } catch (error) {
      if (isCurrent(requestId)) setNotice(error instanceof Error ? error.message : "続きを読み込めませんでした。");
    } finally {
      setLoadingMore(false);
    }
  }, [listQuery, videos.length, begin, isCurrent]);
  // Skips exactly the mount-time reload when the server already rendered
  // this same default (q="") view. See app/lib/use-search-reload.ts.
  useSearchReload(load, q, Boolean(initialVideos));
  const remove = useDeleteVideo({
    onDeleted: (id) => setVideos((current) => current.filter((v) => v.id !== id)),
    onNotice: setNotice,
  });
  // チャンネルごとの本数（読み込んだ分）。絞り込みの選択肢に添える。URL で指定されたチャンネルが
  // 読み込んだ分に無くても、選択肢からは消さない（消すと select が別の値を表示してしまう）。
  const channels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of videos) if (v.channel_name) counts.set(v.channel_name, (counts.get(v.channel_name) ?? 0) + 1);
    if (channel !== "all" && !counts.has(channel)) counts.set(channel, 0);
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b, "ja"));
  }, [videos, channel]);
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
          <p className="tt-kicker">LIBRARY</p>
          <h1>要約一覧</h1>
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
        <span>{shown.length}本の要約{hasMore && "（続きがあります）"}</span>
        <div className="tt-filter-controls">
          <label className="tt-unread-toggle">
            <input type="checkbox" checked={unread} onChange={(e) => setUnread(e.target.checked)} />
            未読のみ
          </label>
          <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="チャンネルで絞り込む">
            <option value="all">すべてのチャンネル</option>
            {channels.map(([name, count]) => (
              <option key={name} value={name}>{name}（{count}）</option>
            ))}
          </select>
        </div>
      </div>
      <div className="tt-video-grid">
        {shown.map((v) => (
          <article className={v.read_at ? "tt-video-card is-read" : "tt-video-card"} key={v.id}>
            {/* prefetch={false}: this page renders 100 of these cards per
                loaded page, and /text-tube/watch/[id] is a Server Component reading
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
                {v.read_at && <em className="tt-read-badge">読了</em>}
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
                    {/* 閲覧数は入っている動画だけに出す（入っていない動画がほとんどで、「0 閲覧」が並ぶだけだった）。 */}
                    {v.view_count > 0 && <>{views(v.view_count)} 閲覧 · </>}記事作成日 {date(v.created_at)}
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
      {/* 並べ替えとチャンネルの絞り込みは、読み込んだ分に対して行う。続きがある間は、それを伝えるボタンを出す。 */}
      {hasMore && (
        <div className="tt-more">
          <button type="button" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "読み込み中…" : "さらに読み込む"}
          </button>
        </div>
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
