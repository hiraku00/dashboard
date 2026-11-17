import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { TextTubeApp } from "@/app/text-tube-app";

// The library used to show only what the first response held. With more videos
// than one page, the rest are reached with「さらに読み込む」, which asks for the
// rows after the ones already shown.

vi.mock("next/navigation", () => ({ usePathname: () => "/text-tube" }));
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
});

const video = (id: string, title: string) => ({
  id, title, channel_name: "Ch", thumbnail_url: "", original_url: "",
  published_at: null, view_count: 0, duration: "", created_at: `2026-01-0${id}`, updated_at: "2026-01-01",
});

test("「さらに読み込む」 appends the next page from the current offset and hides itself at the end", async () => {
  const requested: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    requested.push(url);
    // "2" overlaps what is already shown, as when a video was added in between.
    return Promise.resolve(new Response(JSON.stringify({ videos: [video("2", "SECOND"), video("1", "THIRD")], hasMore: false }), { status: 200, headers: { "content-type": "application/json" } }));
  });

  render(<TextTubeApp initialVideos={[video("3", "FIRST"), video("2", "SECOND")]} initialHasMore />);
  expect(screen.getByText("2本の要約（続きがあります）")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "さらに読み込む" }));
  await waitFor(() => expect(screen.queryByText("THIRD")).not.toBeNull());

  expect(requested).toEqual(["/api/text-tube/videos?q=&offset=2"]);
  expect(screen.getAllByText("SECOND")).toHaveLength(1);
  expect(screen.getByText("3本の要約")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "さらに読み込む" })).toBeNull();
});

test("without a further page there is no button", () => {
  render(<TextTubeApp initialVideos={[video("1", "ONLY")]} />);
  expect(screen.queryByRole("button", { name: "さらに読み込む" })).toBeNull();
});
