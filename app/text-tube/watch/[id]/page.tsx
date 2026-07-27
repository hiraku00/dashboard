"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PortalHeader } from "../../../portal-nav";
import { MarkdownRenderer } from "../../markdown-renderer";

type Video=Record<string,unknown>;
const date=(v:unknown)=>v?new Date(String(v)).toLocaleDateString("ja-JP"):"—";
export default function TextTubeWatchPage({params}:{params:Promise<{id:string}>}){
 const [video,setVideo]=useState<Video|null>(null),[doc,setDoc]=useState(""),[error,setError]=useState("");
 useEffect(()=>{params.then(({id})=>Promise.all([fetch(`/api/text-tube/videos/${id}`).then(r=>r.json()),fetch(`/api/text-tube/videos/${id}/document`).then(r=>r.ok?r.text():"")]).then(([v,d])=>{if(v.error)throw Error(v.error);setVideo(v.video);setDoc(d)}).catch(e=>setError(e.message)));},[params]);
 if(error)return <main className="portal-shell"><PortalHeader title="TextTube" active="/text-tube"/><div className="empty-state"><strong>{error}</strong><Link href="/text-tube">一覧へ戻る</Link></div></main>;
 if(!video)return <main className="portal-shell"><PortalHeader kicker="TEXTTUBE / READING" title="読み込み中…" active="/text-tube"/></main>;
 return <main className="portal-shell"><PortalHeader kicker="TEXTTUBE / READING" title={String(video.title)} active="/text-tube"/><div className="reading-actions"><Link className="secondary-button" href="/text-tube">← ライブラリ</Link><Link className="secondary-button" href="/text-tube/studio">Studioで編集</Link></div><article className="reading-layout"><div className="reading-main">{video.thumbnail_url&&<img className="reading-cover" src={String(video.thumbnail_url)} alt=""/>}<div className="reading-meta"><span>{String(video.channel_name||"チャンネル未設定")}</span><span>公開 {date(video.published_at)}</span><span>作成 {date(video.created_at)}</span>{video.original_url&&<a href={String(video.original_url)} target="_blank" rel="noreferrer">YouTubeで開く ↗</a>}</div><section className="reading-section"><h2>要約</h2><MarkdownRenderer content={String(video.summary||"要約はまだ登録されていません。")}/></section><section className="reading-section"><h2>詳細スクリプト</h2>{doc?<MarkdownRenderer content={doc}/>:<p className="reading-copy muted">詳細スクリプトはまだありません。</p>}</section></div><aside className="reading-aside"><div className="aside-stat"><span>閲覧数</span><strong>{Number(video.view_count||0).toLocaleString("ja-JP")}</strong></div><div className="aside-stat"><span>動画時間</span><strong>{String(video.duration||"—")}</strong></div><div className="aside-stat"><span>保存場所</span><strong>D1 + R2</strong></div><p className="muted-copy">本文はR2、検索しやすいメタデータはD1に保存しています。</p></aside></article></main>;
}
