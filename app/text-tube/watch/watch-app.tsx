"use client";
import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import { MarkdownRenderer } from "../markdown-renderer";
import { TextTubeChrome } from "../../text-tube-app";
import { ApiError, readJson } from "../../lib/json";

type Video = Record<string, unknown>;
const date = (v: unknown) => (v ? new Date(String(v)).toLocaleDateString("ja-JP") : "—");

export function TextTubeWatchApp({
  id,
  initialVideo = null,
  initialDocument = "",
  initialError = "",
}: {
  id: string;
  // Passed by app/text-tube/watch/[id]/page.tsx (a Server Component) after
  // fetching this directly from D1+R2 -- see getVideoDetail() in
  // app/lib/queries/text-tube.ts. `initialError` is set only when the
  // server positively determined the video does not exist (a real 404, not
  // a transient D1/R2 failure) -- see the comment on the effect below for
  // why that distinction matters for whether the client retries.
  initialVideo?: Video | null;
  initialDocument?: string;
  initialError?: string;
}) {
  const [video, setVideo] = useState<Video | null>(initialVideo),
    [doc, setDoc] = useState(initialDocument),
    [error, setError] = useState(initialError);
  useEffect(() => {
    // Two cases skip the client fetch entirely: the server already has the
    // video (normal case), or the server positively confirmed it does not
    // exist (initialError set -- retrying would just 404 again). Only a
    // silent server-side failure (neither video nor error) falls through to
    // the same fetch the pre-RSC page always made on mount, exactly like
    // the fallback in app/page.tsx and app/watch-list-app.tsx.
    if (initialVideo || initialError) return;
    Promise.all([
      fetch(`/api/text-tube/videos/${id}`),
      fetch(`/api/text-tube/videos/${id}/document`).then((r) => (r.ok ? r.text() : "")),
    ])
      .then(async ([videoResponse, text]) => {
        if (!videoResponse.ok) {
          // Prefer the API's own message (e.g. the 404 route's
          // "動画が見つかりません。") when the response actually has one; an
          // unhandled exception on the API side comes back with an empty
          // body instead, and response.json() on that throws "Unexpected
          // end of JSON input" -- that raw parser message is what used to
          // leak to the user here instead of a real fallback.
          const body = (await videoResponse.json().catch(() => null)) as ApiError | null;
          throw new Error(body?.error || "動画を読み込めませんでした。");
        }
        const d = await readJson<{ video: Video }>(videoResponse);
        setVideo(d.video);
        setDoc(text);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "動画を読み込めませんでした。"));
  }, [id, initialVideo, initialError]);

  if (error)
    return (
      <TextTubeChrome>
        <div className="tt-empty">
          {error}
          <Link href="/text-tube" prefetch={false}>一覧に戻る</Link>
        </div>
      </TextTubeChrome>
    );
  if (!video)
    return (
      <TextTubeChrome>
        <div className="tt-loading">読み込み中…</div>
      </TextTubeChrome>
    );

  const readTime = Math.max(1, Math.ceil(String(video.summary ?? "").length / 1000));
  return (
    <TextTubeChrome>
      <div className="tt-reading-layout">
        <article className="tt-reading-main">
          <header className="tt-reading-header">
            <div className="tt-reading-thumb">
              {Boolean(video.thumbnail_url) && (
                <Image src={String(video.thumbnail_url)} alt="" fill sizes="(max-width: 700px) 110px, 180px" unoptimized />
              )}
            </div>
            <div>
              <h1>{String(video.title)}</h1>
              <div className="tt-reading-meta">
                <span>{String(video.channel_name || "チャンネル未設定")}</span>
                <span>•</span>
                <span>{date(video.created_at)}</span>
                <span>•</span>
                <strong>要約読了：約{readTime}分</strong>
              </div>
              {Boolean(video.original_url) && (
                <a className="tt-source-link" href={String(video.original_url)} target="_blank" rel="noreferrer">
                  元の動画を見る ↗
                </a>
              )}
            </div>
          </header>
          <section className="tt-reading-section">
            <h2>要約</h2>
            <MarkdownRenderer content={String(video.summary || "")} />
          </section>
          {doc && (
            <section className="tt-reading-section">
              <h2>詳細スクリプト</h2>
              <MarkdownRenderer content={doc} />
            </section>
          )}
        </article>
        <aside className="tt-next">
          <h2>次の動画</h2>
          <Link href="/text-tube" prefetch={false}>
            <small>おすすめ</small>
            <b>もっと動画を探す</b>
          </Link>
          <Link href="/text-tube/studio" prefetch={false}>
            <small>Studio</small>
            <b>動画を管理する</b>
          </Link>
        </aside>
      </div>
    </TextTubeChrome>
  );
}
