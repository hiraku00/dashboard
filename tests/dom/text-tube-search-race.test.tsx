import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { TextTubeApp } from "@/app/text-tube-app";

// load() used to have no protection against out-of-order responses: typing
// "a" fires a fetch, then typing more (e.g. "aaaaaaaa") fires a second one --
// if the first (broader) query's response happens to resolve AFTER the
// second (narrower) one, it silently overwrites the correct, current result
// with a stale, broader one. This mirrors app/watch-list-app.tsx's
// refreshItems() race, which was fixed with the same requestId guard.

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
  vi.useRealTimers();
});

const video = (id: string, title: string) => ({
  id, title, channel_name: "Ch", thumbnail_url: "", original_url: "", summary: "",
  published_at: null, view_count: 0, duration: "", created_at: "2026-01-01", updated_at: "2026-01-01",
});

test("a slow response for an earlier, broader query does not overwrite a faster, narrower one", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const resolvers = new Map<string, (body: unknown) => void>();
  vi.stubGlobal("fetch", (url: string) => {
    if (!url.startsWith("/api/text-tube/videos")) return Promise.resolve(new Response("{}", { status: 404 }));
    const q = new URL(url, "http://x").searchParams.get("q") ?? "";
    return new Promise<Response>((resolve) => {
      resolvers.set(q, (body) => resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })));
    });
  });

  render(<TextTubeApp initialVideos={[]} />);

  fireEvent.change(screen.getByPlaceholderText("タイトル・チャンネルを検索"), { target: { value: "a" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  fireEvent.change(screen.getByPlaceholderText("タイトル・チャンネルを検索"), { target: { value: "aaaaaaaa" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });

  await waitFor(() => expect(resolvers.has("a")).toBe(true));
  await waitFor(() => expect(resolvers.has("aaaaaaaa")).toBe(true));

  // The narrower, later query resolves first...
  await act(async () => { resolvers.get("aaaaaaaa")!({ videos: [] }); });
  // ...then the broader, earlier query's slow response finally arrives.
  await act(async () => {
    resolvers.get("a")!({ videos: [video("1", "FAKE MATCH 1"), video("2", "FAKE MATCH 2")] });
  });

  expect(screen.queryByText("FAKE MATCH 1")).toBeNull();
  expect(screen.queryByText("該当する動画がありません。")).not.toBeNull();
});
