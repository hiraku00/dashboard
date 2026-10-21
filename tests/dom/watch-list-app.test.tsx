import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { WatchListApp, type Item, type Stats } from "@/app/watch-list-app";

vi.mock("next/navigation", () => ({ usePathname: () => "/watch-list", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string; prefetch?: boolean }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const item = (over: Partial<Item> = {}): Item => ({
  id: "i1", contentType: "movie", creatorName: "NHK", seriesTitle: "", title: "番組A", description: "", priority: null, status: "backlog",
  addedOn: "2026-10-01", watchedOn: null, comment: "", thumbnailUrl: "", version: 1, links: [], ...over,
});
const stats: Stats = { total: 12, completed: 3, movie: 12, audio: 0, text: 0, byStatus: { backlog: 5, in_progress: 2, completed: 3, dropped: 2 }, creators: ["NHK", "テレ東", "ちきりん"] };

/** /api/items への問い合わせを記録し、空でない1件を返す(添え物の /api/text-tube/... は空で返す)。 */
function stubFetch() {
  const itemsUrls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/items")) { itemsUrls.push(url); return json({ items: [item()], pagination: { total: 1 } }); }
    if (url.startsWith("/api/stats")) return json(stats);
    return json({ items: [] });
  }));
  return itemsUrls;
}

test("the status strip shows each status's count and filters the list by the pressed one", async () => {
  const itemsUrls = stubFetch();
  render(<WatchListApp initialItems={{ items: [item()], pagination: { total: 1 } }} initialStats={stats} />);
  const strip = screen.getByRole("group", { name: "状態で絞り込み" });
  const all = within(strip).getByRole("button", { name: /すべて/ });
  expect(all.getAttribute("aria-pressed")).toBe("true");
  expect(all.textContent).toContain("12");
  const completed = within(strip).getByRole("button", { name: /完了/ });
  expect(completed.textContent).toContain("3");
  expect(completed.textContent).toContain("25%");
  expect(screen.queryByRole("button", { name: "条件をクリア" })).toBeNull();

  fireEvent.click(completed);
  await waitFor(() => expect(itemsUrls.some((url) => new URLSearchParams(url.split("?")[1]).get("status") === "completed")).toBe(true));
  expect(completed.getAttribute("aria-pressed")).toBe("true");
  // 状態の select は帯に置き換わった。
  expect(screen.queryByRole("combobox", { name: "状態" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "条件をクリア" }));
  expect(all.getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("button", { name: "条件をクリア" })).toBeNull();
});

test("the creator select lists every creator from stats, not just the current page's", () => {
  stubFetch();
  render(<WatchListApp initialItems={{ items: [item()], pagination: { total: 1 } }} initialStats={stats} />);
  const select = screen.getByRole("combobox", { name: "人物・媒体" });
  expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["すべての人物・媒体", "NHK", "テレ東", "ちきりん"]);
});
