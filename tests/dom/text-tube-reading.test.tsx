import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { TextTubeApp } from "@/app/text-tube-app";
import { TextTubeWatchApp, nearbySiblings, type Sibling } from "@/app/text-tube/watch/watch-app";

// Reading flow: the library shows what is already read and keeps its filters in
// the URL; the article page marks a video read, lists the headings beside the
// text, and links to the neighbouring videos of the same channel.

vi.mock("next/navigation", () => ({ usePathname: () => "/text-tube" }));
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string; prefetch?: boolean }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));
vi.mock("next/image", () => ({ default: () => null }));

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
beforeEach(() => {
  window.history.replaceState(null, "", "/text-tube");
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const listed = (id: string, title: string, readAt: string | null) => ({
  id, title, channel_name: "Ch", thumbnail_url: "", original_url: "",
  published_at: null, view_count: 0, duration: "", created_at: "2026-01-01", updated_at: "2026-01-01", read_at: readAt,
});

test("the library marks read videos, hides a zero view count, and keeps its filters in the URL", async () => {
  const requested: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    requested.push(url);
    return Promise.resolve(new Response(JSON.stringify({ videos: [listed("2", "UNREAD ONE", null)], hasMore: false }), { status: 200, headers: { "content-type": "application/json" } }));
  });
  render(<TextTubeApp initialVideos={[listed("1", "READ ONE", "2026-01-02T00:00:00Z"), listed("2", "UNREAD ONE", null)]} initialChannels={[{ name: "Ch", count: 2 }]} />);

  expect(screen.getAllByText("読了")).toHaveLength(1);
  expect(screen.queryByText(/0 閲覧/)).toBeNull();
  expect(screen.getByRole("option", { name: "Ch（2）" })).toBeTruthy();

  fireEvent.click(screen.getByLabelText("未読のみ"));
  await waitFor(() => expect(requested).toEqual(["/api/text-tube/videos?q=&unread=1"]));
  await waitFor(() => expect(screen.queryByText("READ ONE")).toBeNull());
  expect(window.location.search).toBe("?unread=1");
  expect(window.sessionStorage.getItem("tt-list-url")).toBe("/text-tube?unread=1");

  fireEvent.change(screen.getByDisplayValue("最新順（記事作成日）"), { target: { value: "title-asc" } });
  await waitFor(() => expect(window.location.search).toBe("?sort=title-asc&unread=1"));
});

test("clicking a card's channel name narrows the list to that channel on the server", async () => {
  const requested: string[] = [];
  vi.stubGlobal("scrollTo", () => {});
  vi.stubGlobal("fetch", (url: string) => {
    requested.push(url);
    const body = { videos: [{ ...listed("3", "OTHER CH", null), channel_name: "Other" }], hasMore: false, channels: [{ name: "Ch", count: 2 }, { name: "Other", count: 150 }] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  });
  render(<TextTubeApp initialVideos={[listed("1", "ONE", null), { ...listed("2", "TWO", null), channel_name: "Other" }]} initialChannels={[{ name: "Ch", count: 1 }, { name: "Other", count: 150 }]} />);

  fireEvent.click(screen.getByRole("button", { name: "Other" }));
  await waitFor(() => expect(requested).toEqual(["/api/text-tube/videos?q=&channel=Other"]));
  await waitFor(() => expect(screen.queryByText("ONE")).toBeNull());
  expect(screen.getByText("OTHER CH")).toBeTruthy();
  expect(window.location.search).toBe("?channel=Other");
  // 本数は読み込んだ分ではなく、サーバーが数えた全体。
  expect(screen.getByRole("option", { name: "Other（150）" })).toBeTruthy();

  // 絞っている間は解除ボタンが出て、押すと全チャンネルに戻る。
  fireEvent.click(screen.getByRole("button", { name: "「Other」の絞り込みを解除" }));
  await waitFor(() => expect(requested.at(-1)).toBe("/api/text-tube/videos?q="));
  expect(window.location.search).toBe("");
  expect(screen.queryByRole("button", { name: /の絞り込みを解除/ })).toBeNull();
});

test("the library starts from the view the URL carried", () => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no fetch expected on mount")));
  render(<TextTubeApp initialVideos={[listed("1", "ONLY", null)]} initialView={{ q: "abc", sort: "title-asc", channel: "all", unread: true }} />);
  expect((screen.getByPlaceholderText("タイトル・チャンネルを検索") as HTMLInputElement).value).toBe("abc");
  expect((screen.getByLabelText("未読のみ") as HTMLInputElement).checked).toBe(true);
  expect((screen.getByDisplayValue("タイトル順") as unknown as { value: string }).value).toBe("title-asc");
});

const article = { id: "v2", title: "第2回", channel_name: "Ch", thumbnail_url: "", original_url: "", created_at: "2026-01-01", read_at: null, summary: "## はじめに\n\n本文\n\n## つぎに\n\n本文" };
const siblings = [
  { id: "v1", title: "第1回", thumbnail_url: "", duration: "", published_at: "2022-01-01", created_at: "2026-01-01", read_at: "2026-01-02T00:00:00Z" },
  { id: "v2", title: "第2回", thumbnail_url: "", duration: "", published_at: "2022-01-08", created_at: "2026-01-01", read_at: null },
  { id: "v3", title: "第3回", thumbnail_url: "", duration: "", published_at: "2022-01-15", created_at: "2026-01-01", read_at: null },
];

test("the article page marks the video read and back, and reports a failed save", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  let ok = true;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return Promise.resolve(new Response(JSON.stringify(ok ? { ok: true } : { error: "x" }), { status: ok ? 200 : 500 }));
  });
  render(<TextTubeWatchApp id="v2" initialVideo={article} siblings={siblings} />);

  fireEvent.click(screen.getByRole("button", { name: "読了にする" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "✓ 読了（未読に戻す）" })).toBeTruthy());
  expect(calls).toEqual([{ url: "/api/text-tube/videos/v2/read", body: { read: true } }]);

  ok = false;
  fireEvent.click(screen.getByRole("button", { name: "✓ 読了（未読に戻す）" }));
  await waitFor(() => expect(screen.getByText("読了の状態を保存できませんでした。")).toBeTruthy());
  expect(screen.getByRole("button", { name: "✓ 読了（未読に戻す）" })).toBeTruthy();
});

test("the article page lists the headings, the neighbouring videos, and the way back to the filtered library", async () => {
  window.sessionStorage.setItem("tt-list-url", "/text-tube?unread=1");
  vi.stubGlobal("fetch", () => Promise.resolve(new Response("{}", { status: 200 })));
  render(<TextTubeWatchApp id="v2" initialVideo={article} siblings={siblings} />);

  await waitFor(() => expect(screen.getByRole("button", { name: "はじめに" })).toBeTruthy());
  expect(screen.getByRole("button", { name: "つぎに" })).toBeTruthy();

  const hrefs = (name: RegExp) => screen.getAllByRole("link", { name }).map((link) => link.getAttribute("href"));
  expect(hrefs(/前の回/)).toEqual(["/text-tube/watch/v1"]);
  expect(hrefs(/次の回/)).toEqual(["/text-tube/watch/v3"]);
  expect(screen.getByText("いま読んでいる回")).toBeTruthy();
  expect(screen.getByText(/2022\/1\/1 · 読了/)).toBeTruthy();
  expect(hrefs(/このチャンネルの 3 本/)).toEqual(["/text-tube?channel=Ch"]);
  // 見出しの下のチャンネル名からも、そのチャンネルの一覧へ行ける。
  expect(hrefs(/^Ch$/)).toEqual(["/text-tube?channel=Ch"]);
  await waitFor(() => expect(hrefs(/一覧に戻る/)).toEqual(["/text-tube?unread=1"]));
});

test("the library tucks edit and delete behind a per-card menu, and offers the popularity sort only when views exist", () => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no fetch expected on mount")));
  const { unmount } = render(<TextTubeApp initialVideos={[listed("1", "NO VIEWS", null)]} />);
  expect(screen.getByLabelText("「NO VIEWS」の操作").tagName).toBe("SUMMARY");
  expect(screen.getByRole("link", { name: "編集" }).closest("details")).not.toBeNull();
  expect(screen.queryByRole("option", { name: /人気順/ })).toBeNull();
  unmount();

  render(<TextTubeApp initialVideos={[{ ...listed("2", "VIEWED", null), view_count: 120 }]} />);
  expect(screen.getByRole("option", { name: /人気順/ })).toBeTruthy();
});

test("the article's table of contents numbers its entries like the chapters in the text", async () => {
  vi.stubGlobal("fetch", () => Promise.resolve(new Response("{}", { status: 200 })));
  render(<TextTubeWatchApp id="v2" initialVideo={article} siblings={siblings} />);
  const intro = await screen.findByRole("button", { name: "はじめに" });
  expect(intro.textContent).toBe("01はじめに");
  expect(screen.getByRole("button", { name: "つぎに" }).textContent).toBe("02つぎに");
});

test("同じチャンネルの一覧は、いまの回を先頭に、公開日の近い順に並べる", () => {
  const row = (id: string, published_at: string | null, created_at = "2026-11-01"): Sibling =>
    ({ id, title: id, thumbnail_url: "", duration: "", published_at, created_at, read_at: null });
  // 間の回が登録されていないチャンネル: 最新の「編2」の隣は、近い「編1」、そのあと数年前の回。
  const series = [row("#246", "2022-03-10"), row("#247", "2022-03-14"), row("#248", "2022-03-17"), row("編1", "2026-11-22"), row("編2", "2026-11-25")];
  expect(nearbySiblings(series, 4).map((video) => video.id)).toEqual(["編2", "編1", "#248", "#247"]);
  // 後の回が出たら、前後3本のうち近いものから並ぶ。
  const later = [...series, row("編3", "2026-11-29")];
  expect(nearbySiblings(later, 4).map((video) => video.id)).toEqual(["編2", "編1", "編3", "#248", "#247"]);
  // 公開日が無い回は、並びと同じく記事の作成日で比べる。
  const noDate = [row("a", "2026-01-01"), row("b", null, "2026-06-01"), row("c", "2026-06-02")];
  expect(nearbySiblings(noDate, 0).map((video) => video.id)).toEqual(["a", "b", "c"]);
  expect(nearbySiblings(noDate, 2).map((video) => video.id)).toEqual(["c", "b", "a"]);
  expect(nearbySiblings(noDate, -1)).toEqual([]);
});
