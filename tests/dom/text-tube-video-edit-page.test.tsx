import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MouseEventHandler, ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { TextTubeVideoEditApp } from "@/app/text-tube/video-edit-app";

// The add / edit page that replaced the modal editor (the modal closed on a
// click outside it and lost whatever was typed). See
// app/text-tube/video-edit-app.tsx.

vi.mock("next/navigation", () => ({ usePathname: () => "/text-tube" }));
vi.mock("next/link", () => ({
  default: ({ href, children, className, onClick }: { href: string; children: ReactNode; className?: string; prefetch?: boolean; onClick?: MouseEventHandler }) => (
    <a href={href} className={className} onClick={onClick}>{children}</a>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const video = {
  id: "v1", title: "元のタイトル", channel_name: "Ch", thumbnail_url: "", original_url: "",
  summary: "要約", published_at: null, view_count: 0, duration: "", created_at: "2026-01-01", updated_at: "2026-01-01",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Call = { url: string; method: string; body: unknown };
function stubFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const call = { url, method: init?.method ?? "GET", body: init?.body };
    calls.push(call);
    return handler(call);
  });
  return calls;
}
// Saving ends with a full page load (window.location.href = ...), which jsdom
// does not implement; keep its "not implemented" report out of the output.
const quietNavigation = () => vi.spyOn(console, "error").mockImplementation(() => {});

test("loads the video and its detailed script into the form", async () => {
  stubFetch(({ url }) => (url.endsWith("/document") ? new Response("# 本文") : json({ video })));
  render(<TextTubeVideoEditApp id="v1" />);
  expect(await screen.findByDisplayValue("元のタイトル")).toBeTruthy();
  expect(screen.getByDisplayValue("# 本文")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "動画を編集" })).toBeTruthy();
});

test("a script that fails to load shows an error instead of an empty form that would overwrite it", async () => {
  stubFetch(({ url }) => (url.endsWith("/document") ? json({ error: "x" }, 404) : json({ video })));
  render(<TextTubeVideoEditApp id="v1" />);
  expect(await screen.findByText("本文を読み込めませんでした。")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "保存する" })).toBeNull();
});

test("saving an edit updates the video, then its script", async () => {
  quietNavigation();
  const calls = stubFetch(({ url, method }) =>
    method === "GET" ? (url.endsWith("/document") ? new Response("# 本文") : json({ video })) : json({ ok: true }),
  );
  render(<TextTubeVideoEditApp id="v1" />);
  fireEvent.change(await screen.findByDisplayValue("元のタイトル"), { target: { value: "新しいタイトル" } });
  fireEvent.click(screen.getByRole("button", { name: "保存する" }));
  await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
  const writes = calls.filter((c) => c.method !== "GET");
  expect(writes.map((c) => `${c.method} ${c.url}`)).toEqual([
    "PATCH /api/text-tube/videos/v1",
    "POST /api/text-tube/videos/v1/document",
  ]);
  expect(JSON.parse(String(writes[0].body)).title).toBe("新しいタイトル");
  expect(writes[1].body).toBe("# 本文");
});

test("a new video whose script failed to save is updated, not added again, on the next save", async () => {
  let scriptAttempts = 0;
  const calls = stubFetch(({ url, method }) => {
    if (url.endsWith("/document")) return ++scriptAttempts === 1 ? json({ error: "R2が落ちています" }, 500) : json({ ok: true });
    if (method === "POST") return json({ id: "new1" });
    return json({ ok: true });
  });
  quietNavigation();
  render(<TextTubeVideoEditApp />);
  expect(screen.getByRole("heading", { name: "動画を追加" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/タイトル/), { target: { value: "新しい動画" } });
  fireEvent.change(screen.getByLabelText("詳細スクリプト（Markdown）"), { target: { value: "# 本文" } });
  fireEvent.click(screen.getByRole("button", { name: "追加する" }));
  expect(await screen.findByText(/本文は保存できませんでした: R2が落ちています/)).toBeTruthy();
  // The text is still there to try again.
  expect(screen.getByDisplayValue("# 本文")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "追加する" }));
  await waitFor(() => expect(scriptAttempts).toBe(2));
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    "POST /api/text-tube/videos",
    "POST /api/text-tube/videos/new1/document",
    "PATCH /api/text-tube/videos/new1",
    "POST /api/text-tube/videos/new1/document",
  ]);
});

test("cancelling with unsaved changes asks first, and stays when declined", async () => {
  stubFetch(({ url }) => (url.endsWith("/document") ? new Response("") : json({ video })));
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  render(<TextTubeVideoEditApp id="v1" />);
  const cancel = await screen.findByRole("link", { name: "キャンセル" });
  expect(cancel.getAttribute("href")).toBe("/text-tube/watch/v1");

  // Nothing changed yet: no question.
  expect(fireEvent.click(cancel)).toBe(true);
  expect(confirm).not.toHaveBeenCalled();

  fireEvent.change(screen.getByDisplayValue("元のタイトル"), { target: { value: "変更" } });
  // fireEvent.click returns false when the click's default (following the link) was prevented.
  expect(fireEvent.click(cancel)).toBe(false);
  expect(confirm).toHaveBeenCalledOnce();
});
