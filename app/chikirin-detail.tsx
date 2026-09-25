"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PortalHeader } from "./portal-nav";
import { Body } from "./chikirin-body";
import { MetaForm } from "./chikirin-meta-form";
import { readErrorMessage, readJson } from "./lib/json";
import { formatPostedAt, type Program } from "./lib/openchat-query.ts";
import { linkText } from "./chikirin-app";

/** 1番組(1ノート)の詳細: スレッド主の投稿(番組の情報)と、ちきりんのコメントを全文で。 */
export function ChikirinDetail({ id, initialProgram = null, initialError = "" }: { id: string; initialProgram?: Program | null; initialError?: string }) {
  const [program, setProgram] = useState<Program | null>(initialProgram);
  const [error, setError] = useState(initialError);
  const router = useRouter();
  // 画面を開くたびに最新を読む: 一覧で編集した放送局などが、先読みされた古い画面のままにならないようにする。
  // (サーバーが描いたものは最初の表示に使い、読み直せなくても、その表示は残す)
  useEffect(() => {
    if (initialError) return;
    let alive = true;
    (async () => {
      try {
        const response = await fetch(`/api/openchat/programs/${encodeURIComponent(id)}`, { cache: "no-store" });
        if (!response.ok) throw new Error(await readErrorMessage(response, "読み込めませんでした。"));
        const body = await readJson<{ program: Program }>(response);
        if (alive) setProgram(body.program);
      } catch (e) {
        if (alive && !initialProgram) setError(e instanceof Error ? e.message : "読み込めませんでした。");
      }
    })();
    return () => { alive = false; };
  }, [id, initialError, initialProgram]);

  return <main className="app-shell">
    <PortalHeader title="ちきりんオプチャ" active="/chikirin" />
    <section className="library-panel" aria-label="番組の詳細">
      <p className="chikirin-back"><Link href="/chikirin" prefetch={false}>← 一覧に戻る</Link></p>
      {error && <p className="notice" role="alert">{error}</p>}
      {!program && !error && <p className="chikirin-run">読み込み中…</p>}
      {program && <article className="chikirin-detail">
        <section className="chikirin-meta-edit" aria-labelledby="chikirin-meta-title">
          <h2 id="chikirin-meta-title">放送情報（編集）</h2>
          <MetaForm key={JSON.stringify(program.meta)} program={program} onSaved={() => router.push("/chikirin")} />
        </section>
        <header>
          <p className="chikirin-meta">
            <span>{program.noteByTarget ? "ちきりんのスレッド" : `スレッド: ${program.noteAuthor}`}</span>
            <span>起票 <time dateTime={program.notePostedAt}>{formatPostedAt(program.notePostedAt, program.notePrecision)}</time></span>
            <span>コメント {program.commentCount} 件</span>
            <span>ちきりんのコメント {program.targetComments.length} 件</span>
          </p>
          {program.meta.links.length > 0 && <p className="chikirin-link">{program.meta.links.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noreferrer">{linkText(l.url, l.label)} <span aria-hidden="true">↗</span></a>)}</p>}
          {(program.linkTitle || program.linkUrl) && <p className="chikirin-link">
            {program.linkUrl ? <a href={program.linkUrl} target="_blank" rel="noreferrer">{program.linkTitle || program.linkUrl} <span aria-hidden="true">↗</span></a> : program.linkTitle}
          </p>}
        </header>
        {program.issues.length > 0 && <div className="chikirin-issue-box" role="status"><strong>要確認</strong><ul>{program.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div>}
        {program.noteBody && <section className={program.noteByTarget ? "chikirin-post is-thread" : "chikirin-post is-owner"} aria-label={program.noteByTarget ? "ちきりんのスレッド" : "スレッド主の投稿"}>
          <strong className="chikirin-badge">{program.noteByTarget ? "ちきりんのスレッド" : "スレッド主の投稿（番組の情報）"}</strong>
          <Body text={program.noteBody} full />
        </section>}
        {program.targetComments.map((comment) => <section className="chikirin-post is-comment" key={comment.id} aria-label="ちきりんのコメント">
          <div className="chikirin-post-head"><strong className="chikirin-badge">{program.noteByTarget ? "本人コメント" : "ちきりんのコメント"}</strong><time dateTime={comment.postedAt}>{formatPostedAt(comment.postedAt, comment.precision)}</time></div>
          <Body text={comment.bodyText} full />
        </section>)}
      </article>}
    </section>
  </main>;
}
