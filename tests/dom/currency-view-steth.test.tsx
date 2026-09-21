import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { CurrencyView } from "@/app/manage-asset-currency";

// stETH's chart must not be drawn from a history window that starts after the
// boundary date its two data sources are joined on (it would show one day's
// "reward" as the whole gap). The view fetches the full history first, shows a
// loading line meanwhile, and falls back to what it has if that fails. When the
// history already reaches the boundary it must NOT fetch anything extra.

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => cleanup());

const wallet = (date: string, balance: number) => ({ wallet_id: "lido", wallet_name: "Lido2", as_of_date: date, captured_at: `${date}T02:00:00Z`, fx_usdjpy: 150, total_usd: balance * 3000, tokens: [{ symbol: "stETH", amount_value: balance, usd_value: balance * 3000 }] });
const state = { sources: [], wallets: [], snapshots: [wallet("2026-09-21", 120.2)], exchange_snapshots: [], daily_update: { errors: {} } } as never;
const rewards = [{ date: "2026-07-13", type: "reward", change: 0.001, change_USD: 3, balance: 119.99, apr: 2.5 }, { date: "2026-07-14", type: "reward", change: 0.001, change_USD: 3, balance: 120, apr: 2.5 }] as never;
const shortHistory = { snapshots: [wallet("2026-08-20", 120.1), wallet("2026-09-21", 120.2)], exchange_snapshots: [] } as never;
const fullHistory = { snapshots: [wallet("2026-07-11", 119.9), wallet("2026-09-21", 120.2)], exchange_snapshots: [] } as never;

const props = (over: Record<string, unknown>) => ({ state, history: shortHistory, historyDays: 90, lidoRewards: rewards, usdJpyRates: [], today: "2026-09-21", ensureHistory: vi.fn(async () => {}), ...over }) as Parameters<typeof CurrencyView>[0];

test("a history window that stops short of the boundary: fetches the full history and shows a loading line, not a chart", async () => {
  let resolve!: () => void;
  const ensureHistory = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
  render(<CurrencyView {...props({ ensureHistory })} />);
  await waitFor(() => expect(ensureHistory).toHaveBeenCalledTimes(1));
  expect(ensureHistory).toHaveBeenCalledWith("all");
  expect(screen.getByRole("status").textContent).toContain("読み込み中");
  expect(screen.queryByText("現在残高")).toBeNull(); // no chart / cards from the incomplete history
  await act(async () => { resolve(); });
});

test("once the full history arrives the chart is drawn, and nothing is fetched again", async () => {
  const ensureHistory = vi.fn(async () => {});
  const view = render(<CurrencyView {...props({ ensureHistory })} />);
  await waitFor(() => expect(ensureHistory).toHaveBeenCalledTimes(1));
  view.rerender(<CurrencyView {...props({ ensureHistory, history: fullHistory, historyDays: Infinity })} />);
  await waitFor(() => expect(screen.getByText("現在残高")).toBeTruthy());
  expect(screen.queryByRole("status")).toBeNull();
  expect(ensureHistory).toHaveBeenCalledTimes(1);
});

test("if the fetch fails (history unchanged), it draws what it has instead of waiting forever", async () => {
  const ensureHistory = vi.fn(async () => {}); // ensureHistory swallows errors and keeps the old history
  render(<CurrencyView {...props({ ensureHistory })} />);
  await waitFor(() => expect(screen.getByText("現在残高")).toBeTruthy());
  expect(ensureHistory).toHaveBeenCalledTimes(1); // asked once, not in a loop
});

test("a history that already reaches the boundary fetches nothing extra", async () => {
  const ensureHistory = vi.fn(async () => {});
  render(<CurrencyView {...props({ ensureHistory, history: fullHistory, historyDays: 90 })} />);
  await waitFor(() => expect(screen.getByText("現在残高")).toBeTruthy());
  expect(ensureHistory).not.toHaveBeenCalled();
});

test("the full history (Infinity) never triggers a fetch, even if it starts late", async () => {
  const ensureHistory = vi.fn(async () => {});
  render(<CurrencyView {...props({ ensureHistory, history: shortHistory, historyDays: Infinity })} />);
  await waitFor(() => expect(screen.getByText("現在残高")).toBeTruthy());
  expect(ensureHistory).not.toHaveBeenCalled();
});
