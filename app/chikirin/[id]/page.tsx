import { ChikirinDetail } from "../../chikirin-detail";
import { getProgram } from "@/app/lib/queries/openchat";

// Server Component: 詳細をD1から直接読む(/api/openchat/programs/[id] と同じ getProgram を呼ぶ)。
// 存在しない・一覧に載らないノートは、エラーとして見せる(クライアントは読み直さない)。
export default async function ChikirinDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const program = await getProgram(id);
    if (!program) return <ChikirinDetail id={id} initialError="この番組は見つかりません。" />;
    return <ChikirinDetail id={id} initialProgram={program} />;
  } catch {
    return <ChikirinDetail id={id} />;               // 一時的な失敗は、クライアントが自分で読む
  }
}
