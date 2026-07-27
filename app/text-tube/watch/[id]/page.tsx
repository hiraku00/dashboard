import Link from "next/link";
import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";
import { PortalHeader } from "../../../portal-nav";

export default async function TextTubeWatchPage({ params }: { params: Promise<{ id: string }> }) {
  await ensureSchema({ seed: false }); const { id } = await params; const video = (await env.DB.prepare("SELECT * FROM text_tube_videos WHERE id=? AND deleted_at IS NULL").bind(id).all<Record<string, unknown>>()).results?.[0];
  if (!video) return <main className="portal-shell"><PortalHeader title="TextTube" active="/text-tube" /><div className="empty-state"><strong>動画が見つかりません。</strong><Link href="/text-tube">一覧へ戻る</Link></div></main>;
  return <main className="portal-shell"><PortalHeader kicker="TEXTTUBE / READING" title={String(video.title)} active="/text-tube" /><article className="reading-layout"><div className="reading-main"><div className="reading-meta"><span>{String(video.channel_name || "チャンネル未設定")}</span><span>{String(video.published_at || "")}</span><a href={String(video.original_url || "#")} target="_blank" rel="noreferrer">YouTubeで開く ↗</a></div><section className="reading-section"><h2>要約</h2><p className="reading-copy">{String(video.summary || "要約はまだ登録されていません。")}</p></section><section className="reading-section"><h2>詳細スクリプト</h2><p className="reading-copy muted">本文はR2に保存され、必要なときだけポータルから読み込みます。</p><a className="text-link" href={`/api/text-tube/videos/${id}/document`}>本文を開く →</a></section></div><aside className="reading-aside"><div className="aside-stat"><span>閲覧数</span><strong>{Number(video.view_count ?? 0)}</strong></div><div className="aside-stat"><span>保存場所</span><strong>D1 / R2</strong></div><Link className="secondary-button" href="/text-tube">← 一覧へ戻る</Link></aside></article></main>;
}
