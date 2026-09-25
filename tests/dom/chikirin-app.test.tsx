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
  noteAuthor: "参加者B", noteByTarget: false, notePostedAt: "2026-09-21T06:47:00Z", notePrecision: "exact", targetBody: null, noteBody: "8/23放送のNHKスペシャルです。海の環境を扱った回でした。",
  targetComments: [
    { id: "c1", bodyText: "私もこれ観ました。海の環境への影響が大きいと思いました。", postedAt: "2026-09-21T07:15:00Z", precision: "exact" },
    { id: "c2", bodyText: "追記: 欧州の対策が参考になった。", postedAt: "2026-09-21T09:00:00Z", precision: "approx_hour" },
  ],
  commentCount: 8, lastCheckedAt: "2026-09-24T03:00:00Z", ...over,
});

const page = (programs: unknown[], total = programs.length, pageNo = 1, pageSize = 20) => ({ programs, total, page: pageNo, pageSize }) as unknown as ProgramsPage;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("the list is a table: kind, broadcaster, episode title, thread, poster, times, counts, links and an edit button", () => {
  render(<ChikirinApp initialPage={page([program()])} initialRun={null} />);
  expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["種別", "放送局", "放送タイトル", "スレッド", "スレ主", "投稿", "コメ", "ちきりん", "最新", "リンク", "編集"]);
  const row = screen.getAllByRole("row")[1];
  const cells = within(row).getAllByRole("cell").map((c) => c.textContent ?? "");
  expect(cells[0]).toBe("コメント");
  expect(cells[1]).toBe("NHK BS");
  expect(cells[2]).toBe("地球超解析");
  expect(cells[3]).toContain("8/23放送 NHKスペシャル 地球超解析");
  expect(cells[3]).toContain("私もこれ観ました");                       // 内容の抜粋(最初のちきりんのコメント)
  expect(cells[4]).toBe("参加者B");
  expect(cells[5]).toBe("26/09/21 15:47");
  expect(cells[6]).toBe("8");
  expect(cells[7]).toBe("2");
  expect(cells[8]).toBe("約26/09/21 18:00");
  expect(within(row).getByRole("link", { name: /8\/23放送/ }).getAttribute("href")).toBe("/chikirin/n1");
  expect(within(row).getByRole("link", { name: /番組ページ/ }).getAttribute("href")).toBe("https://example.test/ep");
  expect(screen.queryByLabelText("ちきりんのコメント")).toBeNull();   // 一覧には全文を出さない
});

test("unedited rows show a dash for broadcaster and episode title", () => {
  render(<ChikirinApp initialPage={page([program({ meta: { broadcaster: "", episodeTitle: "", links: [] } })])} initialRun={null} />);
  const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
  expect(cells[1].textContent).toBe("—");
  expect(cells[2].textContent).toBe("—");
});

test("editing saves broadcaster, episode title and links with PUT and updates the row", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(json({ program: program({ meta: { broadcaster: "テレビ東京", episodeTitle: "WBS", links: [{ url: "https://example.test/wbs", label: "" }] } }) }));
  });
  render(<ChikirinApp initialPage={page([program({ meta: { broadcaster: "", episodeTitle: "", links: [] } })])} initialRun={null} />);
  fireEvent.click(screen.getByRole("button", { name: /の放送情報を編集/ }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("放送局"), { target: { value: "テレビ東京" } });
  fireEvent.change(within(dialog).getByLabelText("その日の放送タイトル"), { target: { value: "WBS" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "＋ リンクを追加" }));
  fireEvent.change(within(dialog).getByLabelText("リンク1のURL"), { target: { value: "https://example.test/wbs" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls[0].url).toBe("/api/openchat/programs/n1");
  expect(calls[0].init?.method).toBe("PUT");
  expect(JSON.parse(String(calls[0].init?.body))).toEqual({ broadcaster: "テレビ東京", episodeTitle: "WBS", links: [{ url: "https://example.test/wbs", label: "" }] });
  const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
  expect(cells[1].textContent).toBe("テレビ東京");
  expect(cells[2].textContent).toBe("WBS");
});

test("a rejected edit shows the server's message and keeps the dialog open", async () => {
  vi.stubGlobal("fetch", () => Promise.resolve(json({ error: "リンクのURLは http:// または https:// で始まる正しい形式にしてください。" }, 400)));
  render(<ChikirinApp initialPage={page([program()])} initialRun={null} />);
  fireEvent.click(screen.getByRole("button", { name: /の放送情報を編集/ }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toContain("http://"));
});

test("the target's own thread is marked in the list and previews her body", () => {
  const own = program({ noteByTarget: true, noteAuthor: "ちきりん", targetBody: "9月23日の報道特集の真ん中あたり。" });
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
  vi.stubGlobal("fetch", (url: string) => { urls.push(url); return Promise.resolve(json(page([program({ noteId: "n2", programTitle: "二ページ目の番組" })], 45, 2))); });
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
  expect(posts[1].textContent).toContain("約26/09/21 18:00");
  expect(posts[0].textContent).toContain("26/09/21 16:15");
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
  expect(screen.getByRole("link", { name: /8\/23放送/ })).toBeTruthy();
});

test("shows when the last sync ran and how it ended", () => {
  render(<ChikirinApp initialPage={page([])} initialRun={{ status: "partial", startedAt: "2026-09-24T03:00:00Z", completedAt: "2026-09-24T03:10:00Z", notesScanned: 30, notesOpened: 3, commentsNew: 9, targetCommentsNew: 2, warningCount: 1 }} />);
  const line = screen.getByTestId("run-line").textContent ?? "";
  expect(line).toContain("26/09/24 12:10");
  expect(line).toContain("一部に警告あり");
  expect(line).toContain("警告 1 件");
});
