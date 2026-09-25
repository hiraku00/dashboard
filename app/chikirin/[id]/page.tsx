import { ChikirinDetail } from "../../chikirin-detail";
import { getProgram } from "@/app/lib/queries/openchat";

// Server Component: 詳細をD1から直接読む(/api/openchat/programs/[id] と同じ getProgram を呼ぶ)。
// 存在しない・一覧に載らないノートは、エラーとして見せる(クライアントは読み直さない)。
export default async function ChikirinDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const initial = await fetchInitial(id);
  return <ChikirinDetail id={id} initialProgram={initial.program} initialError={initial.error} />;
}

async function fetchInitial(id: string) {
  try {
    const program = await getProgram(id);
    return program ? { program, error: "" } : { program: null, error: "この番組は見つかりません。" };
  } catch {
    return { program: null, error: "" };               // 一時的な失敗は、クライアントが自分で読む
  }
}
