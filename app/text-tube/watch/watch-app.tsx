"use client";
import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownRenderer } from "../markdown-renderer";
import { LIST_URL_KEY, TextTubeChrome, useDeleteVideo } from "../../text-tube-app";
import { ApiError, readJson } from "../../lib/json";

type Video = Record<string, unknown>;
/** 同じチャンネルの動画の1行（app/lib/queries/text-tube.ts の ChannelVideo）。 */
export type Sibling = { id: string; title: string; thumbnail_url: string; duration: string; published_at: string | null; read_at: string | null };
type TocEntry = { id: string; label: string };

/** sticky な上部（.portal-chrome）の下に見出しが隠れないよう、目次から飛ぶときに空ける高さ。 */
const TOC_OFFSET = 150;
/** 読んだ位置を覚えておく localStorage のキー。値はページ全体に対する割合（0〜1）。 */
const positionKey = (id: string) => `tt-reading-position:${id}`;
/** 横の一覧に出す、いまの回の前後の本数。 */
const NEARBY = 3;

/** 本文の h2 から目次を作り、いま読んでいる見出しを追う。記事は Markdown から描画されるので、
 *  描画が済んだあとの DOM を読む（要約の中身が変わったら作り直す）。 */
function useToc(body: React.RefObject<HTMLElement | null>, content: string) {
  const [entries, setEntries] = useState<TocEntry[]>([]);
  const [active, setActive] = useState("");
  useEffect(() => {
    const root = body.current;
    if (!root) return;
    const found: TocEntry[] = [];
    root.querySelectorAll("h2").forEach((heading, index) => {
      const label = heading.textContent?.trim() ?? "";
      // 「要約」という枠の見出し（本文の外）は目次に入れない。
      if (!label || heading.parentElement?.classList.contains("tt-reading-section")) return;
      if (!heading.id) heading.id = `tt-toc-${index + 1}`;
      found.push({ id: heading.id, label });
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 描画済みの DOM から読むので、effect の中でしか決められない
    setEntries(found);
    if (!found.length) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      let current = "";
      for (const entry of found) {
        const top = document.getElementById(entry.id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= TOC_OFFSET + 20) current = entry.id;
      }
      setActive(current);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("scroll", onScroll); if (frame) cancelAnimationFrame(frame); };
  }, [body, content]);
  return { entries, active };
}
const date = (v: unknown) => (v ? new Date(String(v)).toLocaleDateString("ja-JP") : "—");

export function TextTubeWatchApp({
  id,
  initialVideo = null,
  initialError = "",
  siblings = [],
}: {
  id: string;
  /** 同じチャンネルの動画（公開日の古い順、この動画も含む）。前後の回と、横の一覧に使う。 */
  siblings?: Sibling[];
  // Passed by app/text-tube/watch/[id]/page.tsx (a Server Component) after
  // fetching this directly from D1 -- see getVideoDetail() in
  // app/lib/queries/text-tube.ts. `initialError` is set only when the
  // server positively determined the video does not exist (a real 404, not
  // a transient D1 failure) -- see the comment on the effect below for why
  // that distinction matters for whether the client retries.
  initialVideo?: Video | null;
  initialError?: string;
}) {
  const [video, setVideo] = useState<Video | null>(initialVideo),
    [error, setError] = useState(initialError),
    [notice, setNotice] = useState("");
  const [readAt, setReadAt] = useState<string | null>(initialVideo?.read_at ? String(initialVideo.read_at) : null);
  const [listUrl, setListUrl] = useState("/text-tube");
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const body = useRef<HTMLElement>(null);
  const end = useRef<HTMLDivElement>(null);
  /** 自動で読了にするのは、このページを開いている間に1回だけ。手で未読に戻したあと、もう一度勝手に読了にしない。 */
  const autoMarked = useRef(false);
  const { entries: toc, active: activeHeading } = useToc(body, String(video?.summary ?? ""));

  const markRead = useCallback(async (read: boolean) => {
    const previous = readAt;
    setReadAt(read ? new Date().toISOString() : null);
    try {
      const response = await fetch(`/api/text-tube/videos/${id}/read`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ read }) });
      if (!response.ok) throw new Error();
      if (read) { try { window.localStorage.removeItem(positionKey(id)); } catch { /* 無くても困らない */ } }
    } catch {
      setReadAt(previous);
      setNotice("読了の状態を保存できませんでした。");
    }
  }, [id, readAt]);

  // 一覧から来たときは、絞り込みを保ったままの一覧へ戻れるようにする（一覧が sessionStorage に覚えている）。
  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(LIST_URL_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage はサーバーの描画では読めない
      if (stored?.startsWith("/text-tube")) setListUrl(stored);
    } catch { /* 読めなければ既定の一覧 */ }
  }, []);

  // 読んだ位置を覚えておき、次に開いたときに「続きから読む」を出す。勝手には飛ばさない
  // （目次や前後のリンクから来た人を、途中へ連れていかないため）。
  const hasVideo = Boolean(video);
  useEffect(() => {
    if (!hasVideo) return;
    try {
      const stored = Number(window.localStorage.getItem(positionKey(id)));
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage はサーバーの描画では読めない
      if (stored > 0.05 && stored < 0.95) setResumeAt(stored);
    } catch { /* 読めなければ出さないだけ */ }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      setScrolled(window.scrollY > 600);
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        const range = document.documentElement.scrollHeight - window.innerHeight;
        if (range <= 0) return;
        try { window.localStorage.setItem(positionKey(id), (window.scrollY / range).toFixed(3)); } catch { /* 保存できなくても読める */ }
      }, 500);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("scroll", onScroll); if (timer) clearTimeout(timer); };
  }, [id, hasVideo]);

  // 本文の終わりまで来たら読了にする。
  useEffect(() => {
    const target = end.current;
    if (!target || readAt || autoMarked.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((records) => {
      if (!records.some((record) => record.isIntersecting) || autoMarked.current) return;
      autoMarked.current = true;
      void markRead(true);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [readAt, markRead, hasVideo]);

  const position = useMemo(() => siblings.findIndex((sibling) => sibling.id === id), [siblings, id]);
  const previous = position > 0 ? siblings[position - 1] : null;
  const next = position >= 0 && position < siblings.length - 1 ? siblings[position + 1] : null;
  const nearby = position >= 0 ? siblings.slice(Math.max(0, position - NEARBY), position + NEARBY + 1) : [];
  const jumpTo = (headingId: string) => {
    const target = document.getElementById(headingId);
    if (target) window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - TOC_OFFSET });
  };
  const resume = () => {
    if (resumeAt === null) return;
    window.scrollTo({ top: resumeAt * (document.documentElement.scrollHeight - window.innerHeight) });
    setResumeAt(null);
  };
  const remove = useDeleteVideo({
    // A full page load, not a client-side navigation: the library's list
    // could otherwise come back from the client router cache with the
    // deleted video still in it (the same reason chikirin-detail.tsx goes
    // back to its list this way after saving).
    onDeleted: () => { window.location.href = "/text-tube"; },
    onNotice: setNotice,
  });
  useEffect(() => {
    // Two cases skip the client fetch entirely: the server already has the
    // video (normal case), or the server positively confirmed it does not
    // exist (initialError set -- retrying would just 404 again). Only a
    // silent server-side failure (neither video nor error) falls through to
    // the same fetch the pre-RSC page always made on mount, exactly like
    // the fallback in app/page.tsx and app/watch-list-app.tsx.
    if (initialVideo || initialError) return;
    fetch(`/api/text-tube/videos/${id}`)
      .then(async (videoResponse) => {
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
      {notice && <div className="tt-notice">{notice}</div>}
      <nav className="tt-reading-nav">
        <Link href={listUrl} prefetch={false}>← 一覧に戻る</Link>
        {resumeAt !== null && !readAt && (
          <button type="button" className="tt-resume" onClick={resume}>
            前回は {Math.round(resumeAt * 100)}% まで読みました。続きから読む
          </button>
        )}
      </nav>
      <div className="tt-reading-layout">
        <article className="tt-reading-main" ref={body}>
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
              <div className="tt-card-actions tt-reading-actions">
                <button type="button" className={readAt ? "tt-read-toggle is-read" : "tt-read-toggle"} aria-pressed={Boolean(readAt)} onClick={() => { autoMarked.current = true; void markRead(!readAt); }}>
                  {readAt ? "✓ 読了（未読に戻す）" : "読了にする"}
                </button>
                <Link href={`/text-tube/watch/${id}/edit`} prefetch={false}>
                  編集
                </Link>
                <button
                  type="button"
                  className="danger"
                  onClick={() => remove({ id, title: String(video.title) })}
                >
                  削除
                </button>
              </div>
            </div>
          </header>
          <section className="tt-reading-section">
            <h2>要約</h2>
            <MarkdownRenderer content={String(video.summary || "")} videoUrl={video.original_url ? String(video.original_url) : null} />
          </section>
          <div ref={end} aria-hidden="true" />
          {(previous || next) && (
            <nav className="tt-series-nav" aria-label="同じチャンネルの前後の動画">
              {previous ? <Link href={`/text-tube/watch/${previous.id}`} prefetch={false}><small>← 前の回</small><b>{previous.title}</b></Link> : <span />}
              {next ? <Link className="is-next" href={`/text-tube/watch/${next.id}`} prefetch={false}><small>次の回 →</small><b>{next.title}</b></Link> : <span />}
            </nav>
          )}
        </article>
        <aside className="tt-next">
          {toc.length > 1 && (
            <section className="tt-toc" aria-label="目次">
              <h2>目次</h2>
              <ol>
                {toc.map((entry) => (
                  <li key={entry.id}>
                    <button type="button" className={entry.id === activeHeading ? "is-active" : undefined} aria-current={entry.id === activeHeading ? "location" : undefined} onClick={() => jumpTo(entry.id)}>
                      {entry.label}
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {nearby.length > 1 ? (
            <section className="tt-siblings">
              <h2>同じチャンネル</h2>
              {nearby.map((sibling) => sibling.id === id ? (
                <span key={sibling.id} className="tt-sibling is-current" aria-current="page"><small>いま読んでいる回</small><b>{sibling.title}</b></span>
              ) : (
                <Link key={sibling.id} className="tt-sibling" href={`/text-tube/watch/${sibling.id}`} prefetch={false}>
                  <small>{date(sibling.published_at)}{sibling.read_at ? " · 読了" : ""}</small>
                  <b>{sibling.title}</b>
                </Link>
              ))}
              <Link className="tt-sibling-all" href={`/text-tube?channel=${encodeURIComponent(String(video.channel_name ?? ""))}`} prefetch={false}>
                このチャンネルの {siblings.length} 本を一覧で見る
              </Link>
            </section>
          ) : (
            <Link className="tt-sibling" href={listUrl} prefetch={false}>
              <small>一覧</small>
              <b>ほかの要約を探す</b>
            </Link>
          )}
        </aside>
      </div>
      {scrolled && (
        <button type="button" className="tt-to-top" onClick={() => window.scrollTo({ top: 0 })} aria-label="ページの先頭へ戻る">
          ↑ 先頭へ
        </button>
      )}
    </TextTubeChrome>
  );
}
