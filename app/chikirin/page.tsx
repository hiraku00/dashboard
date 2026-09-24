import { ChikirinApp } from "../chikirin-app";
import { latestOpenchatRun, listPrograms } from "@/app/lib/queries/openchat";

// Server Component: 最初のページ(絞り込みなし)をD1から直接読む。/api/openchat/programs と同じ
// app/lib/queries/openchat.ts を呼ぶので、ページとAPIで一覧の中身がずれない。
export default async function ChikirinPage() {
  const initial = await fetchInitial();
  return <ChikirinApp initialPage={initial?.page ?? null} initialRun={initial?.run ?? null} />;
}

async function fetchInitial() {
  // 失敗しても画面は出す: initialPage が null なら、クライアントが /api/openchat/programs を自分で読む
  // (Watch List と同じ。一時的なSSR側の失敗をエラーとして見せない)。
  try {
    const [page, run] = await Promise.all([listPrograms({}), latestOpenchatRun()]);
    return { page, run };
  } catch {
    return null;
  }
}
