import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { ChikirinApp, type ProgramsPage } from "@/app/chikirin-app";

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
  noteAuthor: "参加者B", noteByTarget: false, notePostedAt: "2026-09-21T06:47:00Z", notePrecision: "exact", targetBody: null,
  targetComments: [
    { id: "c1", bodyText: "私もこれ観ました。海の環境への影響が大きいと思いました。", postedAt: "2026-09-21T07:15:00Z", precision: "exact" },
    { id: "c2", bodyText: "追記: 欧州の対策が参考になった。", postedAt: "2026-09-21T09:00:00Z", precision: "approx_hour" },
  ],
  commentCount: 8, lastCheckedAt: "2026-09-24T03:00:00Z", ...over,
});

const page = (programs: unknown[], nextCursor: string | null = null) => ({ programs, nextCursor }) as unknown as ProgramsPage;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("shows every comment by the target on a program, oldest first, with approximate times marked", () => {
  render(<ChikirinApp initialPage={page([program()])} initialRun={null} />);
  const card = screen.getByRole("article");
  expect(within(card).getByText("8/23放送 NHKスペシャル 地球超解析")).toBeTruthy();
  const posts = within(card).getAllByLabelText("ちきりんさんのコメント");
  expect(posts).toHaveLength(2);
  expect(posts[0].textContent).toContain("私もこれ観ました");
  expect(posts[1].textContent).toContain("約 2026.09.21 18:00");
  expect(posts[0].textContent).toContain("2026.09.21 16:15");
  expect(within(card).getByText("スレッド: 参加者B")).toBeTruthy();
  expect(within(card).queryByLabelText("ちきりんさんのスレッド")).toBeNull();
  expect(screen.getByRole("link", { name: /地球超解析 NHKオンデマンド/ }).getAttribute("href")).toBe("https://www.nhk-ondemand.jp/x");
});

test("the target's own thread shows the body, her own comments are labelled 本人コメント", () => {
  const own = program({ noteByTarget: true, noteAuthor: "ちきりん", targetBody: "9月23日の報道特集の真ん中あたり。", targetComments: [
    { id: "c9", bodyText: "本人スレッドへの補足", postedAt: "2026-09-23T14:00:00Z", precision: "exact" }] });
  render(<ChikirinApp initialPage={page([own])} initialRun={null} />);
  expect(screen.getByLabelText("ちきりんさんのスレッド").textContent).toContain("9月23日の報道特集");
  expect(screen.getByText("本人コメント")).toBeTruthy();
});

test("long text is collapsed and can be expanded", () => {
  const long = Array.from({ length: 12 }, (_, i) => `${i + 1}行目の内容です。`).join("\n");
  render(<ChikirinApp initialPage={page([program({ targetComments: [{ id: "c1", bodyText: long, postedAt: "2026-09-21T07:15:00Z", precision: "exact" }] })])} initialRun={null} />);
  const toggle = screen.getByRole("button", { name: "全文を表示" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(screen.getByRole("button", { name: "閉じる" }).getAttribute("aria-expanded")).toBe("true");
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
  fireEvent.click(screen.getByRole("button", { name: "ちきりんさんのスレッド" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  await waitFor(() => expect(urls.some((u) => u.includes("kind=thread"))).toBe(true));
});

test("『さらに読み込む』 appends the next page using the cursor", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", (url: string) => { urls.push(url); return Promise.resolve(json(page([program({ noteId: "n2", programTitle: "二ページ目の番組" })], null))); });
  render(<ChikirinApp initialPage={page([program()], "CURSOR123")} initialRun={null} />);
  fireEvent.click(screen.getByRole("button", { name: "さらに読み込む" }));
  await waitFor(() => expect(screen.getByText("二ページ目の番組")).toBeTruthy());
  expect(urls[0]).toContain("cursor=CURSOR123");
  expect(screen.getAllByRole("article")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "さらに読み込む" })).toBeNull();
});

test("a failed request shows a message and keeps the list", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("", { status: 500 }))));
  render(<ChikirinApp initialPage={page([program()], "C")} initialRun={null} />);
  fireEvent.click(screen.getByRole("button", { name: "さらに読み込む" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("続きを読み込めませんでした"));
  expect(screen.getAllByRole("article")).toHaveLength(1);
});

test("shows when the last sync ran and how it ended", () => {
  render(<ChikirinApp initialPage={page([])} initialRun={{ status: "partial", startedAt: "2026-09-24T03:00:00Z", completedAt: "2026-09-24T03:10:00Z", notesScanned: 30, notesOpened: 3, commentsNew: 9, targetCommentsNew: 2, warningCount: 1 }} />);
  const line = screen.getByTestId("run-line").textContent ?? "";
  expect(line).toContain("2026.09.24 12:10");
  expect(line).toContain("一部に警告あり");
  expect(line).toContain("警告 1 件");
});
