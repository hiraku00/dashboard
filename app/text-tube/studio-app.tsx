"use client";
import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TextTubeChrome,
  Video,
  VideoEditor,
  formToPayload,
} from "../text-tube-app";
import { readJson } from "../lib/json";
const date = (v?: string | null) =>
  v ? new Date(v).toLocaleDateString("ja-JP") : "—";
export function TextTubeStudioApp({
  initialVideos = null,
}: {
  // Passed by app/text-tube/studio/page.tsx (a Server Component) after
  // fetching this directly from D1 -- see app/lib/queries/text-tube.ts. It
  // calls listVideos({}) with no query, matching the default filter state
  // below (q=""). See the matching comment in app/text-tube-app.tsx for the
  // full rationale.
  initialVideos?: Video[] | null;
} = {}) {
  const [videos, setVideos] = useState<Video[]>(initialVideos ?? []),
    [q, setQ] = useState(""),
    [sort, setSort] = useState("created_at-desc"),
    [editing, setEditing] = useState<
      (Video & { detailedScript?: string }) | null
    >(null),
    [notice, setNotice] = useState("");
  const skippedInitialFetch = useRef(false);
  const load = useCallback(async () => {
    const r = await fetch(`/api/text-tube/videos?q=${encodeURIComponent(q)}`);
    if (r.ok) setVideos((await readJson<{ videos: Video[] }>(r)).videos);
  }, [q]);
  useEffect(() => {
    if (initialVideos && !skippedInitialFetch.current) {
      skippedInitialFetch.current = true;
      return;
    }
    void load();
    // `initialVideos` intentionally omitted -- see the matching comment in
    // app/watch-list-app.tsx.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);
  const sorted = useMemo(
    () =>
      videos
        .slice()
        .sort((a, b) =>
          sort === "view_count-desc"
            ? b.view_count - a.view_count
            : sort === "title-asc"
              ? a.title.localeCompare(b.title)
              : sort === "created_at-asc"
                ? a.created_at.localeCompare(b.created_at)
                : b.created_at.localeCompare(a.created_at),
        ),
    [videos, sort],
  );
  async function edit(v: Video) {
    const [detail, doc] = await Promise.all([
      fetch(`/api/text-tube/videos/${v.id}`).then((r) => readJson<{ video: Video }>(r)),
      fetch(`/api/text-tube/videos/${v.id}/document`).then((r) =>
        r.ok ? r.text() : "",
      ),
    ]);
    setEditing({ ...detail.video, detailedScript: doc });
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const r = await fetch(`/api/text-tube/videos/${editing.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        formToPayload({
          title: editing.title,
          channelName: editing.channel_name,
          originalUrl: editing.original_url,
          thumbnailUrl: editing.thumbnail_url,
          channelThumbnailUrl: editing.channel_thumbnail_url ?? "",
          summary: editing.summary,
          detailedScript: editing.detailedScript ?? "",
          publishedAt: editing.published_at ?? "",
          viewCount: editing.view_count,
          duration: editing.duration,
        }),
      ),
    });
    if (r.ok) {
      await fetch(`/api/text-tube/videos/${editing.id}/document`, {
        method: "POST",
        body: editing.detailedScript ?? "",
      });
      setEditing(null);
      setNotice("保存しました。");
      load();
    } else setNotice("更新できませんでした。");
  }
  async function remove(id: string) {
    if (!confirm("この動画を削除しますか？")) return;
    await fetch(`/api/text-tube/videos/${id}`, { method: "DELETE" });
    load();
  }
  return (
    <TextTubeChrome active="/text-tube/studio">
      <div className="tt-studio-head">
        <div>
          <p className="tt-kicker">STUDIO</p>
          <h1>Studio デスク</h1>
          <p>動画の管理・要約の編集・統計確認が行えます。</p>
        </div>
      </div>
      {notice && <div className="tt-notice">{notice}</div>}
      <section className="tt-studio-panel">
        <div className="tt-studio-tools">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="管理動画を検索…"
          />
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="created_at-desc">最新順（記事作成日）</option>
            <option value="view_count-desc">人気順（閲覧数）</option>
            <option value="created_at-asc">古い順</option>
            <option value="title-asc">タイトル順</option>
          </select>
        </div>
        <div className="tt-table-scroll">
          <table className="tt-studio-table">
            <thead>
              <tr>
                <th>動画 / コンテンツ</th>
                <th>閲覧数</th>
                <th>テキスト量</th>
                <th>日付管理</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((v) => (
                <tr key={v.id}>
                  <td>
                    <div className="tt-studio-video">
                      <div className="tt-studio-thumb">
                        {v.thumbnail_url ? (
                          <Image
                            src={v.thumbnail_url}
                            alt=""
                            fill
                            sizes="140px"
                            unoptimized
                            onError={(event) => {
                              event.currentTarget.hidden = true;
                              event.currentTarget.parentElement?.classList.add(
                                "missing-thumbnail",
                              );
                            }}
                          />
                        ) : null}
                        <span aria-hidden="true">▶</span>
                      </div>
                      <div>
                        {/* prefetch={false}: this table can list up to 100
                            rows -- see the matching comment on the video
                            grid Links in app/text-tube-app.tsx. */}
                        <Link href={`/text-tube/watch/${v.id}`} prefetch={false}>{v.title}</Link>
                        <small>{v.channel_name || "チャンネル未設定"}</small>
                      </div>
                    </div>
                  </td>
                  <td>{v.view_count.toLocaleString("ja-JP")}</td>
                  <td>
                    <span
                      className={
                        v.detailed_script_object_key
                          ? "tt-status-good"
                          : "tt-status-muted"
                      }
                    >
                      {v.detailed_script_object_key ? "保存済み" : "なし"}
                    </span>
                  </td>
                  <td>
                    {date(v.created_at)}
                    <small>更新 {date(v.updated_at)}</small>
                  </td>
                  <td>
                    <button className="tt-table-action" onClick={() => edit(v)}>
                      編集
                    </button>
                    <button
                      className="tt-table-action danger"
                      onClick={() => remove(v.id)}
                    >
                      削除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {editing && (
        <VideoEditor
          title="動画を編集"
          value={{
            title: editing.title,
            channelName: editing.channel_name,
            originalUrl: editing.original_url,
            thumbnailUrl: editing.thumbnail_url,
            channelThumbnailUrl: editing.channel_thumbnail_url ?? "",
            summary: editing.summary,
            detailedScript: editing.detailedScript ?? "",
            publishedAt: editing.published_at ?? "",
            viewCount: editing.view_count,
            duration: editing.duration,
          }}
          onChange={(v) =>
            setEditing({
              ...editing,
              title: v.title,
              channel_name: v.channelName,
              original_url: v.originalUrl,
              thumbnail_url: v.thumbnailUrl,
              channel_thumbnail_url: v.channelThumbnailUrl,
              summary: v.summary,
              detailedScript: v.detailedScript,
              published_at: v.publishedAt,
              view_count: v.viewCount,
              duration: v.duration,
            })
          }
          onClose={() => setEditing(null)}
          onSubmit={save}
          submitLabel="保存する"
        />
      )}
    </TextTubeChrome>
  );
}
