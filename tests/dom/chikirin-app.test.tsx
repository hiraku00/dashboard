import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { ChikirinApp, type ProgramsPage } from "@/app/chikirin-app";
import { ChikirinDetail } from "@/app/chikirin-detail";

vi.mock("next/navigation", () => ({ usePathname: () => "/chikirin" }));
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string; prefetch?: boolean }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const program = (over: Record<string, unknown> = {}) => ({
  noteId: "n1", programTitle: "8/23放送 NHKスペシャル 地球超解析", linkTitle: "地球超解析 NHKオンデマンド", linkUrl: "https://www.nhk-ondemand.jp/x",
  latestAt: "2026-09-21T09:00:00Z", latestPrecision: "approx_hour", meta: { broadcaster: "NHK BS", episodeTitle: "地球超解析", links: [{ url: "https://example.test/ep", label: "番組ページ" }] },
  issues: [], newestSeenAt: "",
  noteAuthor: "参加者B", noteByTarget: false, notePostedAt: "2026-09-21T06:47:00Z", notePrecision: "exact", targetBody: null, noteBody: "8/23放送のNHKスペシャルです。海の環境を扱った回でした。",
  targetComments: [
    { id: "c1", bodyText: "私もこれ観ました。海の環境への影響が大きいと思いました。", postedAt: "2026-09-21T07:15:00Z", precision: "exact" },
    { id: "c2", bodyText: "追記: 欧州の対策が参考になった。", postedAt: "2026-09-21T09:00:00Z", precision: "approx_hour" },
  ],
  commentCount: 8, lastCheckedAt: "2026-09-24T03:00:00Z", ...over,
});

const page = (programs: unknown[], total = programs.length, pageNo = 1, pageSize = 20) => ({ programs, total, page: pageNo, pageSize }) as unknown as ProgramsPage;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("the list is a table: kind, broadcaster, episode title, thread, poster, times, counts, status and links (read-only; editing is on the detail page)", () => {
  render(<ChikirinApp initialPage={page([program()])} initialRun={null} />);
  expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["種別", "放送局", "タイトル", "スレ主", "投稿", "コメント全体", "コメントちきりん", "最新ちきりん", "状態", "リンク"]);
  const row = screen.getAllByRole("row")[1];
  const cells = within(row).getAllByRole("cell").map((c) => c.textContent ?? "");
  expect(cells[0]).toBe("コメント");
  expect(cells[1]).toBe("NHK BS");
  expect(cells[2]).toContain("地球超解析");                              // 1行目: 編集した放送タイトル
  expect(cells[2]).toContain("8/23放送のNHKスペシャルです。");           // 2行目: スレッドの冒頭
  expect(cells[3]).toBe("参加者B");
  expect(cells[4]).toBe("26.09.21 15:47");
  expect(cells[5]).toBe("8");
  expect(cells[6]).toBe("2");
  expect(cells[7]).toBe("約26.09.21 18:00");
  expect(cells[8]).toBe("OK");
  expect(within(row).getByRole("link", { name: "地球超解析" }).getAttribute("href")).toBe("/chikirin/n1");
  expect(within(row).getByRole("link", { name: /番組ページ/ }).getAttribute("href")).toBe("https://example.test/ep");
  expect(screen.queryByLabelText("ちきりんのコメント")).toBeNull();   // 一覧には全文を出さない
});

test("a row with a problem shows 要確認 with the reason, so it can be found in the list", () => {
  const bad = program({ issues: ["コメントの件数が表示と合わず、再確認待ちです（次回の同期でやり直します）。"] });
  render(<ChikirinApp initialPage={page([bad, program({ noteId: "n2" })])} initialRun={null} />);
  const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
  expect(cells[8].textContent).toBe("要確認");
  expect(within(cells[8]).getByText("要確認").getAttribute("title")).toContain("再確認待ち");
  expect(within(screen.getAllByRole("row")[2]).getAllByRole("cell")[8].textContent).toBe("OK");
});

test("the times are labelled as Japan time", () => {
  render(<ChikirinApp initialPage={page([program()])} initialRun={null} />);
  expect(screen.getByText(/日時は日本時間\(JST\)/)).toBeTruthy();
});

test("unedited rows: dash for broadcaster, and the title falls back to the thread's first line without repeating it in the second line", () => {
  render(<ChikirinApp initialPage={page([program({ meta: { broadcaster: "", episodeTitle: "", links: [] }, programTitle: "スレッドの1行目", noteBody: "スレッドの1行目\n本文の2行目です。" })])} initialRun={null} />);
  const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
  expect(cells[1].textContent).toBe("—");
  expect(within(cells[2]).getByRole("link").textContent).toBe("スレッドの1行目");
  expect(cells[2].textContent).toBe("スレッドの1行目本文の2行目です。");
});

test("the list has no edit button: editing happens on the detail page", () => {
  render(<ChikirinApp initialPage={page([program()])} initialRun={null} />);
  expect(screen.queryByRole("button", { name: /編集/ })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("the status cell is centered", () => {
  render(<ChikirinApp initialPage={page([program()])} initialRun={null} />);
  const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
  expect(cells[8].className).toContain("center");
});

test("rows first seen in the last run are marked 新着, and the header says how many programs are new", () => {
  const run = { status: "success", startedAt: "2026-09-25T00:00:00Z", completedAt: "2026-09-25T00:10:00Z", notesScanned: 3, notesOpened: 2, commentsNew: 4, targetCommentsNew: 2, warningCount: 0, warnings: [], newPrograms: 1 };
  render(<ChikirinApp initialPage={page([program({ newestSeenAt: "2026-09-25T00:05:00Z" }), program({ noteId: "n2", programTitle: "前からある番組", newestSeenAt: "2026-09-24T00:05:00Z" })])} initialRun={run} />);
  const rows = screen.getAllByRole("row");
  expect(within(rows[1]).getByText("新着")).toBeTruthy();
  expect(within(rows[2]).queryByText("新着")).toBeNull();
  expect(screen.getByTestId("run-line").textContent).toContain("新着 1 番組");
});

test("the target's own thread is marked in the list and previews her body", () => {
  const own = program({ noteByTarget: true, noteAuthor: "ちきりん", targetBody: "9月23日の報道特集の真ん中あたり。", noteBody: "9月23日の報道特集の真ん中あたり。" });
  render(<ChikirinApp initialPage={page([own])} initialRun={null} />);
  const row = screen.getAllByRole("row")[1];
  expect(within(row).getAllByRole("cell")[0].textContent).toBe("スレッド");
  expect(row.textContent).toContain("9月23日の報道特集");
});

test("shows the total and the range, and numbered pagination when there is more than one page", () => {
  render(<ChikirinApp initialPage={page([program()], 45)} initialRun={null} />);
  expect(screen.getByText("45 件中 1–20")).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "ページ移動" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "3" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "前のページ" }).hasAttribute("disabled")).toBe(true);
});

test("no pagination when everything fits on one page", () => {
  render(<ChikirinApp initialPage={page([program()], 3)} initialRun={null} />);
  expect(screen.queryByRole("navigation", { name: "ページ移動" })).toBeNull();
});

test("moving to page 2 requests page=2 and shows that page; a new search goes back to page 1", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", (url: string) => { urls.push(url); return Promise.resolve(json(page([program({ noteId: "n2", programTitle: "二ページ目の番組", meta: { broadcaster: "", episodeTitle: "", links: [] } })], 45, 2))); });
  render(<ChikirinApp initialPage={page([program()], 45)} initialRun={null} />);
  fireEvent.click(screen.getByRole("button", { name: "次のページ" }));
  await waitFor(() => expect(screen.getByText("二ページ目の番組")).toBeTruthy());
  expect(urls[0]).toContain("page=2");
  expect(screen.getByText("45 件中 21–40")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("検索"), { target: { value: "鉄道" } });
  await waitFor(() => expect(urls.some((u) => u.includes("q=%E9%89%84%E9%81%93") && !u.includes("page="))).toBe(true));
});

test("detail shows the thread owner's post and every comment by the target, oldest first, with approximate times marked", () => {
  render(<ChikirinDetail id="n1" initialProgram={program() as never} />);
  expect(screen.getByRole("link", { name: "← 一覧に戻る" }).getAttribute("href")).toBe("/chikirin");
  expect(screen.getByText("8/23放送 NHKスペシャル 地球超解析")).toBeTruthy();
  expect(screen.getByLabelText("スレッド主の投稿").textContent).toContain("海の環境を扱った回");   // 番組の情報
  const posts = screen.getAllByLabelText("ちきりんのコメント");
  expect(posts).toHaveLength(2);
  expect(posts[0].textContent).toContain("私もこれ観ました");
  expect(posts[1].textContent).toContain("約26.09.21 18:00");
  expect(posts[0].textContent).toContain("26.09.21 16:15");
  expect(screen.getByRole("link", { name: /地球超解析 NHKオンデマンド/ }).getAttribute("href")).toBe("https://www.nhk-ondemand.jp/x");
});

test("detail of the target's own thread shows her body once and labels her comments 本人コメント", () => {
  const own = program({ noteByTarget: true, noteAuthor: "ちきりん", targetBody: "9月23日の報道特集の真ん中あたり。", noteBody: "9月23日の報道特集の真ん中あたり。", targetComments: [
    { id: "c9", bodyText: "本人スレッドへの補足", postedAt: "2026-09-23T14:00:00Z", precision: "exact" }] });
  render(<ChikirinDetail id="n1" initialProgram={own as never} />);
  expect(screen.getByLabelText("ちきりんのスレッド").textContent).toContain("9月23日の報道特集");
  expect(screen.queryByLabelText("スレッド主の投稿")).toBeNull();
  expect(screen.getByText("本人コメント")).toBeTruthy();
});

test("detail shows long text in full without a fold", () => {
  const long = Array.from({ length: 12 }, (_, i) => `${i + 1}行目の内容です。`).join("\n");
  render(<ChikirinDetail id="n1" initialProgram={program({ targetComments: [{ id: "c1", bodyText: long, postedAt: "2026-09-21T07:15:00Z", precision: "exact" }] }) as never} />);
  expect(screen.queryByRole("button", { name: "全文を表示" })).toBeNull();
  expect(screen.getByText(/12行目の内容です/)).toBeTruthy();
});

test("detail fetches on its own when the server sent nothing, and shows a not-found message from the server", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json({ program: program() }))));
  const { unmount } = render(<ChikirinDetail id="n1" />);
  await waitFor(() => expect(screen.getByText("8/23放送 NHKスペシャル 地球超解析")).toBeTruthy());
  unmount();
  render(<ChikirinDetail id="zzz" initialError="この番組は見つかりません。" />);
  expect(screen.getByRole("alert").textContent).toContain("見つかりません");
});

test("does not refetch on mount when the server already rendered the default view", async () => {
  const fetchSpy = vi.fn(() => Promise.resolve(json(page([]))));
  vi.stubGlobal("fetch", fetchSpy);
  render(<ChikirinApp initialPage={page([program()])} initialRun={null} />);
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("fetches on its own when the server sent nothing, and shows the empty state", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json(page([])))));
  render(<ChikirinApp initialPage={null} initialRun={null} />);
  await waitFor(() => expect(screen.getByText("該当する番組はありません。")).toBeTruthy());
});

test("search and kind filter go to the API as query parameters", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const urls: string[] = [];
  vi.stubGlobal("fetch", (url: string) => { urls.push(url); return Promise.resolve(json(page([program({ noteId: "n2" })]))); });
  render(<ChikirinApp initialPage={page([program()])} initialRun={null} />);
  fireEvent.change(screen.getByLabelText("検索"), { target: { value: "鉄道" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  await waitFor(() => expect(urls.some((u) => u.includes("q=%E9%89%84%E9%81%93"))).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "ちきりんのスレッド" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  await waitFor(() => expect(urls.some((u) => u.includes("kind=thread"))).toBe(true));
});

test("a failed request shows a message and keeps the list", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("", { status: 500 }))));
  render(<ChikirinApp initialPage={page([program()], 45)} initialRun={null} />);
  fireEvent.click(screen.getByRole("button", { name: "次のページ" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("一覧を読み込めませんでした"));
  expect(screen.getByRole("link", { name: "地球超解析" })).toBeTruthy();
});

test("shows when the last sync ran and how it ended", () => {
  render(<ChikirinApp initialPage={page([])} initialRun={{ status: "partial", startedAt: "2026-09-24T03:00:00Z", completedAt: "2026-09-24T03:10:00Z", notesScanned: 30, notesOpened: 3, commentsNew: 9, targetCommentsNew: 2, warningCount: 1, warnings: ["本文を開けませんでした: 対象のノート"] }} />);
  const line = screen.getByTestId("run-line").textContent ?? "";
  expect(line).toContain("26.09.24 12:00");
  expect(line).toContain("一部に警告あり");
  expect(line).toContain("最後の取得");
  expect(line).toContain("JST");
});

test("the sync warnings are listed with what they are about", () => {
  render(<ChikirinApp initialPage={page([])} initialRun={{ status: "partial", startedAt: "2026-09-24T03:00:00Z", completedAt: "2026-09-24T03:10:00Z", notesScanned: 30, notesOpened: 3, commentsNew: 9, targetCommentsNew: 2, warningCount: 1, warnings: ["本文を開けませんでした: 対象のノート"] }} />);
  expect(screen.getByText("警告 1 件")).toBeTruthy();
  expect(screen.getByText("本文を開けませんでした: 対象のノート")).toBeTruthy();
});

test("links without a label show the site name: www.web.nhk becomes NHK ONE, other sites their domain, a label wins", async () => {
  const { linkText } = await import("@/app/chikirin-app");
  expect(linkText("https://www.web.nhk/tv/pl/series-tep-XXXX", "")).toBe("NHK ONE");
  expect(linkText("https://www.nhk-ondemand.jp/goods/G1/", "")).toBe("nhk-ondemand.jp");
  expect(linkText("https://www.web.nhk/tv/x", "番組ページ")).toBe("番組ページ");
  expect(linkText("not a url", "")).toBe("not a url");
});
