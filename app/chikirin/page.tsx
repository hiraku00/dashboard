import { ChikirinApp } from "../chikirin-app";
import { parseKind, parseSort } from "@/app/lib/openchat-query";
import { latestOpenchatRun, listPrograms } from "@/app/lib/queries/openchat";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// vinextの静的解析はsearchParamsの読み取りだけでは動的ページと判定しない(ビルド時に "?"
// (未分類)になる。実機で「詳細から一覧に戻ると、URLはpage=2なのにpage=1の内容が表示される」
// ことを確認した: このページのSSRキャッシュがパス名だけで作られ、クエリ文字列(page/q/kind)を
// 区別していないため。force-dynamicで、このページを常にキャッシュさせない。
export const dynamic = "force-dynamic";

// Server Component: 最初のページをD1から直接読む。/api/openchat/programs と同じ
// app/lib/queries/openchat.ts を呼ぶので、ページとAPIで一覧の中身がずれない。
// クエリ(q・kind・page)は、詳細から「一覧に戻る」ときに元の検索・絞り込み・ページへ戻すためのもの。
export default async function ChikirinPage({ searchParams }: { searchParams: SearchParams }) {
  const { q, kind, sort, page } = await readQuery(searchParams);
  const initial = await fetchInitial(q, kind, sort, page);
  return <ChikirinApp initialPage={initial?.page ?? null} initialRun={initial?.run ?? null} initialQuery={q} initialKind={kind} initialSort={sort} />;
}

async function readQuery(searchParams: SearchParams) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
  return { q: one(sp.q), kind: parseKind(one(sp.kind)), sort: parseSort(one(sp.sort)), page: one(sp.page) };
}

async function fetchInitial(q: string, kind: ReturnType<typeof parseKind>, sort: ReturnType<typeof parseSort>, page: string) {
  // 失敗しても画面は出す: initialPage が null なら、クライアントが /api/openchat/programs を自分で読む
  // (Watch List と同じ。一時的なSSR側の失敗をエラーとして見せない)。
  try {
    const [initialPage, run] = await Promise.all([listPrograms({ q, kind, sort, page }), latestOpenchatRun()]);
    return { page: initialPage, run };
  } catch {
    return null;
  }
}
