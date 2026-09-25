import { getProgram, saveProgramMeta } from "@/app/lib/queries/openchat";
import { route } from "@/app/lib/route";

/** 詳細: 1ノート(1番組)のスレッド主の投稿と、ちきりんのコメント全部。一覧に載らないノートは404。 */
export const GET = route(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const program = await getProgram(id);
  if (!program) return Response.json({ error: "見つかりません。" }, { status: 404 });
  return Response.json({ program });
});

/** 人が編集する情報(放送局・その日の放送タイトル・リンク)の保存。collector の同期データには触れない。 */
export const PUT = route(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "入力が正しくありません。" }, { status: 400 }); }
  const result = await saveProgramMeta(id, body);
  if (result === null) return Response.json({ error: "見つかりません。" }, { status: 404 });
  if ("error" in result) return Response.json({ error: result.error }, { status: 400 });
  return Response.json({ program: result });
});
