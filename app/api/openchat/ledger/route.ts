import { exportLedger } from "@/app/lib/queries/openchat";
import { route } from "@/app/lib/route";

/** collectorのローカル台帳の復元用。D1の読み取り行数が多いので、`?confirm=restore` を付けた
 *  明示的な呼び出しだけに応じる(画面の先読みや誤アクセスで使用量を消費しないため)。 */
export const GET = route(async (request: Request) => {
  if (new URL(request.url).searchParams.get("confirm") !== "restore") {
    return Response.json({ error: "台帳の復元用です。必要なときだけ ?confirm=restore を付けて呼び出してください。" }, { status: 400 });
  }
  return Response.json(await exportLedger());
});
