import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { CurrencyView } from "@/app/manage-asset-currency";

// The currency view reads what the other views do not: the history with every
// token and position, the Lido rewards, the FX rates. It asks for them the first
// time it is on screen (`active`), draws nothing until they are in, and for stETH
// -- whose chart joins the Lido CSV to the snapshots at a boundary date -- asks for
// the full history when the window in hand stops short of it, in ONE request.
// Failure: with no full rows there is nothing to draw, so it says so and offers a
// retry; with full rows that are merely short of the stETH boundary it draws what
// it has rather than wait.

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => cleanup());

const wallet = (date: string, balance: number) => ({ wallet_id: "lido", wallet_name: "Lido2", as_of_date: date, captured_at: `${date}T02:00:00Z`, fx_usdjpy: 150, total_usd: balance * 3000, tokens: [{ symbol: "stETH", amount_value: balance, usd_value: balance * 3000 }] });
const state = { sources: [], wallets: [], snapshots: [wallet("2026-09-21", 120.2)], exchange_snapshots: [], daily_update: { errors: {} } } as never;
const rewards = [{ date: "2026-07-13", type: "reward", change: 0.001, change_USD: 3, balance: 119.99, apr: 2.5 }, { date: "2026-07-14", type: "reward", change: 0.001, change_USD: 3, balance: 120, apr: 2.5 }] as never;
const shortHistory = { snapshots: [wallet("2026-08-20", 120.1), wallet("2026-09-21", 120.2)], exchange_snapshots: [] } as never;
const fullHistory = { snapshots: [wallet("2026-07-11", 119.9), wallet("2026-09-21", 120.2)], exchange_snapshots: [] } as never;

type Props = Parameters<typeof CurrencyView>[0];
const props = (over: Partial<Props>): Props => ({
  state, history: fullHistory, historyDays: 90, historyDetail: true, active: true, lidoRewards: rewards, usdJpyRates: [] as never, today: "2026-09-21",
  ensureHistory: vi.fn(async () => true), ensureCurrencyData: vi.fn(async () => {}), ...over,
});

test("not on screen: loads nothing (every view stays mounted, this one is usually hidden)", async () => {
  const p = props({ active: false, historyDetail: false, lidoRewards: null, usdJpyRates: null });
  render(<CurrencyView {...p} />);
  await act(async () => {});
  expect(p.ensureHistory).not.toHaveBeenCalled();
  expect(p.ensureCurrencyData).not.toHaveBeenCalled();
});

test("on screen without its data: asks for the full rows and the extras, and shows a loading line, not a chart", async () => {
  const p = props({ historyDetail: false, lidoRewards: null, usdJpyRates: null, history: fullHistory });
  render(<CurrencyView {...p} />);
  await waitFor(() => expect(p.ensureHistory).toHaveBeenCalledTimes(1));
  expect(p.ensureHistory).toHaveBeenCalledWith("7", true); // the view's own period; the window in hand already covers it
  expect(p.ensureCurrencyData).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status").textContent).toContain("読み込み中");
  expect(screen.queryByText("現在残高")).toBeNull();
});

test("once everything is in, the chart is drawn and nothing is asked for again", async () => {
  const p = props({ historyDetail: false, lidoRewards: null, usdJpyRates: null });
  const view = render(<CurrencyView {...p} />);
  await waitFor(() => expect(p.ensureHistory).toHaveBeenCalledTimes(1));
  view.rerender(<CurrencyView {...p} historyDetail lidoRewards={rewards} usdJpyRates={[] as never} />);
  await waitFor(() => expect(screen.getByText("現在残高")).toBeTruthy());
  expect(screen.queryByRole("status")).toBeNull();
  expect(p.ensureHistory).toHaveBeenCalledTimes(1);
  expect(p.ensureCurrencyData).toHaveBeenCalledTimes(1);
});

test("data already held (opened as the first view): draws at once; the ensure calls are no-ops it can make freely", async () => {
  const p = props({});
  render(<CurrencyView {...p} />);
  await waitFor(() => expect(screen.getByText("現在残高")).toBeTruthy());
  expect(screen.queryByRole("status")).toBeNull();
});

test("stETH with a window that stops short of the boundary: asks for the full history in one request, loading meanwhile", async () => {
  let resolve!: (ok: boolean) => void;
  const p = props({ history: shortHistory, ensureHistory: vi.fn(() => new Promise<boolean>((r) => { resolve = r; })) });
  render(<CurrencyView {...p} />);
  await waitFor(() => expect(p.ensureHistory).toHaveBeenCalledTimes(1));
  expect(p.ensureHistory).toHaveBeenCalledWith("all", true);
  expect(screen.getByRole("status")).toBeTruthy();
  expect(screen.queryByText("現在残高")).toBeNull(); // no chart from the incomplete history
  await act(async () => { resolve(true); });
});

test("stETH: once the full history arrives the chart is drawn, with no second request", async () => {
  const p = props({ history: shortHistory });
  const view = render(<CurrencyView {...p} />);
  await waitFor(() => expect(p.ensureHistory).toHaveBeenCalledWith("all", true));
  view.rerender(<CurrencyView {...p} history={fullHistory} historyDays={Infinity} />);
  await waitFor(() => expect(screen.getByText("現在残高")).toBeTruthy());
  expect(p.ensureHistory).toHaveBeenCalledTimes(1);
});

test("stETH short of the boundary and the fetch fails: draws what it has instead of waiting forever", async () => {
  const p = props({ history: shortHistory, ensureHistory: vi.fn(async () => false) });
  render(<CurrencyView {...p} />);
  await waitFor(() => expect(screen.getByText("現在残高")).toBeTruthy());
  expect(p.ensureHistory).toHaveBeenCalledTimes(1); // asked once, not in a loop
});

test("no full rows and the fetch fails: says so, and a retry asks again", async () => {
  const ensureHistory = vi.fn<Props["ensureHistory"]>().mockResolvedValueOnce(false).mockResolvedValue(true);
  const p = props({ historyDetail: false, lidoRewards: null, usdJpyRates: null, ensureHistory });
  render(<CurrencyView {...p} />);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("読み込めませんでした"));
  fireEvent.click(screen.getByRole("button", { name: "再試行" }));
  await waitFor(() => expect(ensureHistory).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a history that already reaches the boundary needs no extra request", async () => {
  const p = props({ history: fullHistory, historyDays: 90 });
  render(<CurrencyView {...p} />);
  await waitFor(() => expect(screen.getByText("現在残高")).toBeTruthy());
  expect(p.ensureHistory).toHaveBeenCalledWith("7", true); // the ordinary period, not "all"
});

test("the full history (Infinity) never asks for more, even if it starts late", async () => {
  const p = props({ history: shortHistory, historyDays: Infinity });
  render(<CurrencyView {...p} />);
  await waitFor(() => expect(screen.getByText("現在残高")).toBeTruthy());
  expect(p.ensureHistory).toHaveBeenCalledWith("7", true);
});
