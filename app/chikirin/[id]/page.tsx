import { ChikirinDetail } from "../../chikirin-detail";
import { getProgram } from "@/app/lib/queries/openchat";

// Server Component: 詳細をD1から直接読む(/api/openchat/programs/[id] と同じ getProgram を呼ぶ)。
// 存在しない・一覧に載らないノートは、エラーとして見せる(クライアントは読み直さない)。
export default async function ChikirinDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const initial = await fetchInitial(id);
  return <ChikirinDetail id={id} initialProgram={initial.program} initialError={initial.error} backHref={await backHref(searchParams)} />;
}

// 一覧の検索・絞り込み・ページを保つ戻り先。詳細を開いたときの一覧の位置(2ページ目など)に、保存後もそのまま戻れるように。
async function backHref(searchParams: Promise<Record<string, string | string[] | undefined>>) {
  const sp = await searchParams;
  const listQuery = new URLSearchParams();
  for (const key of ["q", "kind", "page"]) {
    const value = sp[key];
    if (typeof value === "string" && value) listQuery.set(key, value);
  }
  return `/chikirin${listQuery.toString() ? `?${listQuery}` : ""}`;
}

async function fetchInitial(id: string) {
  try {
    const program = await getProgram(id);
    return program ? { program, error: "" } : { program: null, error: "この番組は見つかりません。" };
  } catch {
    return { program: null, error: "" };               // 一時的な失敗は、クライアントが自分で読む
  }
}
