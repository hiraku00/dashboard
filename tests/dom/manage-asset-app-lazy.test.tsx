import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ManageAssetApp } from "@/app/manage-asset-app";

// The page used to load everything for every tab (about 1.2MB). Now it loads the
// overview's summary, and the currency view's data -- full history rows, Lido
// rewards, FX rates -- the first time that tab is opened. These tests drive the
// real app, tab clicks included, and record what it fetches.

vi.mock("next/navigation", () => ({ usePathname: () => "/manage-asset" }));
vi.mock("next/link", () => ({
  default: ({ href, children, onClick, className }: { href: string; children: ReactNode; onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void; className?: string; prefetch?: boolean }) => (
    <a href={href} className={className} onClick={(event) => { onClick?.(event); event.preventDefault(); }}>{children}</a>
  ),
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});

const wallet = (date: string, balance: number) => ({ wallet_id: "lido", wallet_name: "Lido2", as_of_date: date, captured_at: `${date}T02:00:00Z`, fx_usdjpy: 150, total_usd: balance * 3000, tokens: [{ symbol: "stETH", amount_value: balance, usd_value: balance * 3000 }] });
const summaryRow = (date: string, balance: number) => ({ wallet_id: "lido", as_of_date: date, captured_at: `${date}T02:00:00Z`, total_usd: balance * 3000 });
const state = { snapshots: [wallet("2026-09-21", 120.2)], exchange_snapshots: [], sources: [], wallets: [], daily_update: { errors: {} } } as never;
const summaryHistory = { snapshots: [summaryRow("2026-07-11", 119.9), summaryRow("2026-09-21", 120.2)], exchange_snapshots: [] } as never;
const truncatedSummary = { snapshots: [summaryRow("2026-08-20", 120.1), summaryRow("2026-09-21", 120.2)], exchange_snapshots: [] } as never;
const detailHistory = { snapshots: [wallet("2026-07-11", 119.9), wallet("2026-09-21", 120.2)], exchange_snapshots: [] };
const lidoRows = [{ date: "2026-07-13", type: "reward", change: 0.001, change_USD: 3, balance: 119.99, apr: 2.5 }];

type Call = { url: string };
let calls: Call[] = [];
let handler: (url: string) => Response | Promise<Response> = () => new Response("{}", { status: 404 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const defaultHandler = (url: string) => {
  if (url.startsWith("/api/manage-asset/history")) return json(url.includes("summary=1") ? summaryHistory : detailHistory);
  if (url.startsWith("/api/lido-rewards")) return json({ rows: lidoRows });
  if (url.startsWith("/api/usd-jpy-rates")) return json({ rows: [] });
  return json({}, 404);
};
beforeEach(() => {
  calls = [];
  handler = defaultHandler;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => { calls.push({ url: String(input) }); return handler(String(input)); }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const urls = () => calls.map((call) => call.url);
const tab = (name: string) => screen.getByRole("button", { name });
const app = (over: Partial<Parameters<typeof ManageAssetApp>[0]> = {}) => render(
  <ManageAssetApp initialView="overview" initialState={state} initialHistory={summaryHistory} initialHistoryDetail={false} initialLatestSyncRun={null} {...over} />,
);

test("opening the page fetches nothing when it was rendered with the overview's summary", async () => {
  app();
  await act(async () => {});
  expect(urls()).toEqual([]);
});

test("opening the currency tab fetches the full history, the Lido rewards and the FX rates, once each", async () => {
  app();
  fireEvent.click(tab("通貨推移"));
  await waitFor(() => expect(screen.getAllByText("現在残高").length).toBeGreaterThan(0));
  expect(urls().filter((u) => u.startsWith("/api/manage-asset/history"))).toEqual(["/api/manage-asset/history?days=90"]); // no summary=1: the full rows
  expect(urls().filter((u) => u.startsWith("/api/lido-rewards"))).toHaveLength(1);
  expect(urls().filter((u) => u.startsWith("/api/usd-jpy-rates"))).toHaveLength(1);
});

test("leaving the currency tab and coming back does not fetch again", async () => {
  app();
  fireEvent.click(tab("通貨推移"));
  await waitFor(() => expect(screen.getAllByText("現在残高").length).toBeGreaterThan(0));
  const before = urls().length;
  fireEvent.click(tab("保管場所"));
  fireEvent.click(tab("通貨推移"));
  fireEvent.click(tab("資産概要"));
  fireEvent.click(tab("通貨推移"));
  await act(async () => {});
  expect(urls()).toHaveLength(before);
});

test("tabs other than the currency tab never trigger its fetches", async () => {
  app();
  for (const name of ["保管場所", "データ更新", "設定", "資産概要"]) fireEvent.click(tab(name));
  await act(async () => {});
  expect(urls()).toEqual([]);
});

test("while the currency data is coming there is a loading line, not a half-drawn chart", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  handler = async (url) => { if (url.startsWith("/api/manage-asset/history")) await gate; return defaultHandler(url); };
  app();
  fireEvent.click(tab("通貨推移"));
  await waitFor(() => expect(screen.getAllByText("通貨推移のデータを読み込み中…").length).toBe(1));
  expect(screen.queryAllByText("現在残高")).toHaveLength(0);
  await act(async () => { release(); });
  await waitFor(() => expect(screen.getAllByText("現在残高").length).toBeGreaterThan(0));
});

test("the overview asks for the summary form when it needs a wider period than it holds", async () => {
  app();
  fireEvent.click(screen.getAllByRole("button", { name: "全期間" })[0]); // the page holds 90 days; "all" needs more
  await waitFor(() => expect(urls()).toContain("/api/manage-asset/history?days=all&summary=1"));
});

test("a period the page already covers asks for nothing", async () => {
  app();
  fireEvent.click(screen.getAllByRole("button", { name: "30日" })[0]);
  fireEvent.click(screen.getAllByRole("button", { name: "90日" })[0]);
  await act(async () => {});
  expect(urls()).toEqual([]);
});

test("once the full rows are held, a wider overview period asks for full rows, not the summary (never downgrades)", async () => {
  app({ initialHistory: summaryHistory });
  fireEvent.click(tab("通貨推移"));
  await waitFor(() => expect(screen.getAllByText("現在残高").length).toBeGreaterThan(0));
  calls = [];
  fireEvent.click(tab("資産概要"));
  fireEvent.click(screen.getAllByRole("button", { name: "全期間" })[0]);
  await waitFor(() => expect(urls().some((u) => u.startsWith("/api/manage-asset/history?days=all"))).toBe(true));
  expect(urls().some((u) => u.includes("summary=1"))).toBe(false);
});

test("a slow summary answer cannot overwrite the full rows that arrived first", async () => {
  let releaseSummary!: () => void;
  const summaryGate = new Promise<void>((r) => { releaseSummary = r; });
  handler = async (url) => { if (url.includes("summary=1")) await summaryGate; return defaultHandler(url); };
  app();
  // overview period change -> a slow summary request is in flight
  fireEvent.click(screen.getAllByRole("button", { name: "全期間" })[0]);
  await waitFor(() => expect(urls().some((u) => u.includes("summary=1"))).toBe(true));
  // meanwhile the currency tab loads the full rows and draws
  fireEvent.click(tab("通貨推移"));
  await waitFor(() => expect(screen.getAllByText("現在残高").length).toBeGreaterThan(0));
  // the slow summary lands afterwards: the currency view must still be drawn from the full rows
  await act(async () => { releaseSummary(); });
  await act(async () => {});
  expect(screen.getAllByText("現在残高").length).toBeGreaterThan(0);
  expect(screen.queryAllByText("通貨推移のデータを読み込み中…")).toHaveLength(0);
});

test("stETH with a summary window short of the boundary: the currency tab makes ONE history request, for the full history", async () => {
  app({ initialHistory: truncatedSummary });
  fireEvent.click(tab("通貨推移"));
  await waitFor(() => expect(screen.getAllByText("現在残高").length).toBeGreaterThan(0));
  expect(urls().filter((u) => u.startsWith("/api/manage-asset/history"))).toEqual(["/api/manage-asset/history?days=all"]);
});

test("rendered as the currency view with everything already held (the /manage-asset/currencies route): no fetch at all", async () => {
  app({ initialView: "currency", initialHistory: detailHistory as never, initialHistoryDetail: true, initialLidoRewards: lidoRows as never, initialUsdJpyRates: [] as never });
  await waitFor(() => expect(screen.getAllByText("現在残高").length).toBeGreaterThan(0));
  expect(urls()).toEqual([]);
});

test("the full-history fetch failing shows an error with a retry, and the retry recovers", async () => {
  let fail = true;
  handler = (url) => (url.startsWith("/api/manage-asset/history") && fail ? new Response("nope", { status: 500 }) : defaultHandler(url));
  app();
  fireEvent.click(tab("通貨推移"));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("読み込めませんでした"));
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "再試行" }));
  await waitFor(() => expect(screen.getAllByText("現在残高").length).toBeGreaterThan(0));
});

test("no server-rendered data: falls back to fetching the summary for the overview and none of the currency extras", async () => {
  handler = (url) => {
    if (url.startsWith("/api/manage-asset/state")) return json(state);
    if (url.startsWith("/api/manage-asset/sync")) return json({ latest: null });
    return defaultHandler(url);
  };
  render(<ManageAssetApp initialView="overview" />);
  await waitFor(() => expect(urls().some((u) => u.startsWith("/api/manage-asset/state"))).toBe(true));
  await act(async () => {});
  expect(urls().filter((u) => u.startsWith("/api/manage-asset/history"))).toEqual(["/api/manage-asset/history?days=90&summary=1"]);
  expect(urls().some((u) => u.startsWith("/api/lido-rewards") || u.startsWith("/api/usd-jpy-rates"))).toBe(false);
});
