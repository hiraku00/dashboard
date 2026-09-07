/** To Do board の読み取りロジック（D1呼び出しを伴うオーケストレーション層）。
 *  app/api/todos/board, app/api/todos/routines の GET と、/todo ページの
 *  Server Component の両方がこれを呼ぶ -- ロジックを複製すると「ページとAPIで
 *  表示件数がずれる」種類のバグを作るので、正はここに一本化する
 *  （app/lib/queries/watch-list.tsと同じ理由）。
 *
 *  書き込み系（POST/PATCH/DELETE、materializeRoutines）はここには置かない。
 *  app/api/todos/_lib.ts および各 route.ts に残したまま -- Issue #71で
 *  materializeRoutines()をGET経路から追い出したのは「読み取りは書き込まない」
 *  という原則を徹底するためで、この読み取り専用ファイルに書き込みを持ち込むと
 *  その原則が崩れる。 */
import { env } from "cloudflare:workers";
import { BOARD_ID, boardColumns, taskShape } from "@/app/api/todos/_lib";

export type BoardSnapshot = {
  board: { id: string; name: string; timezone: string };
  date: string;
  columns: Array<Record<string, unknown>>;
  tasks: ReturnType<typeof taskShape>[];
  summary: { total: number; completed: number; today: number };
};

/** app/api/todos/board の GET と、/todo ページの初期表示が両方呼ぶ。 */
export async function boardSnapshot(date: string): Promise<BoardSnapshot> {
  const columns = await boardColumns();
  const rows = (await env.DB.prepare("SELECT * FROM todo_tasks WHERE board_id=? AND deleted_at IS NULL AND (occurrence_date=? OR occurrence_date IS NULL) ORDER BY position,created_at").bind(BOARD_ID, date).all<Record<string, unknown>>()).results ?? [];
  const tasks = rows.map(taskShape);
  const today = columns.find((column) => column.kind === "today")?.id;
  const done = columns.find((column) => column.kind === "done")?.id;
  return {
    board: { id: BOARD_ID, name: "To Do", timezone: "Asia/Bangkok" },
    date,
    columns,
    tasks,
    summary: {
      total: tasks.filter((task) => task.occurrenceDate).length,
      completed: tasks.filter((task) => task.columnId === done && task.occurrenceDate === date).length,
      today: tasks.filter((task) => task.columnId === today).length,
    },
  };
}

/** app/api/todos/routines の GET と、/todo ページの初期表示が両方呼ぶ。 */
export async function listRoutines(): Promise<Record<string, unknown>[]> {
  await boardColumns();
  return (await env.DB.prepare("SELECT * FROM todo_routines WHERE board_id=? AND deleted_at IS NULL ORDER BY active DESC,created_at DESC").bind(BOARD_ID).all<Record<string, unknown>>()).results ?? [];
}
