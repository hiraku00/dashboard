import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { TextTubeApp } from "@/app/text-tube-app";
import { TextTubeWatchApp } from "@/app/text-tube/watch/watch-app";

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
  render(<TextTubeApp initialVideos={[listed("1", "READ ONE", "2026-01-02T00:00:00Z"), listed("2", "UNREAD ONE", null)]} />);

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

test("the library starts from the view the URL carried", () => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no fetch expected on mount")));
  render(<TextTubeApp initialVideos={[listed("1", "ONLY", null)]} initialView={{ q: "abc", sort: "title-asc", channel: "all", unread: true }} />);
  expect((screen.getByPlaceholderText("タイトル・チャンネルを検索") as HTMLInputElement).value).toBe("abc");
  expect((screen.getByLabelText("未読のみ") as HTMLInputElement).checked).toBe(true);
  expect((screen.getByDisplayValue("タイトル順") as unknown as { value: string }).value).toBe("title-asc");
});

const article = { id: "v2", title: "第2回", channel_name: "Ch", thumbnail_url: "", original_url: "", created_at: "2026-01-01", read_at: null, summary: "## はじめに\n\n本文\n\n## つぎに\n\n本文" };
const siblings = [
  { id: "v1", title: "第1回", thumbnail_url: "", duration: "", published_at: "2022-01-01", read_at: "2026-01-02T00:00:00Z" },
  { id: "v2", title: "第2回", thumbnail_url: "", duration: "", published_at: "2022-01-08", read_at: null },
  { id: "v3", title: "第3回", thumbnail_url: "", duration: "", published_at: "2022-01-15", read_at: null },
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
  await waitFor(() => expect(hrefs(/一覧に戻る/)).toEqual(["/text-tube?unread=1"]));
});
