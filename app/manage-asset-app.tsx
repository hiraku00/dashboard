"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AssetRow } from "@/app/lib/manage-asset-core";
import { localDate } from "@/app/lib/manage-asset-format";
import { neededDays, type Period } from "@/app/lib/manage-asset-chart";
import { PortalHeader } from "./portal-nav";
import { AssetOverview, type AssetHistoryData, type AssetStateData } from "./manage-asset-overview";
import { LocationsView } from "./manage-asset-locations";
import { CurrencyView } from "./manage-asset-currency";
import { SettingsView } from "./manage-asset-settings";
import { SyncView } from "./manage-asset-sync-view";

const assetViews = [
  ["overview", "資産概要"],
  ["locations", "保管場所"],
  ["currency", "通貨推移"],
  ["update", "データ更新"],
  ["settings", "設定"],
] as const;

export type AssetView = (typeof assetViews)[number][0];

/** GET a list endpoint that answers { rows }; a failure is "no rows", never an error. */
const fetchRows = (url: string): Promise<AssetRow[]> =>
  fetch(url, { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : { rows: [] }))
    .catch(() => ({ rows: [] }))
    .then((body) => (body as { rows?: AssetRow[] }).rows ?? []);

const subscribeNoop = () => () => {};
const emptyString = () => "";

export function ManageAssetApp({
  initialView = "overview",
  initialState = null,
  initialHistory = null,
  initialHistoryDetail,
  initialLidoRewards = null,
  initialUsdJpyRates = null,
  initialLatestSyncRun = null,
}: {
  initialView?: AssetView;
  initialState?: AssetStateData | null;
  initialHistory?: AssetHistoryData | null;
  /** Whether `initialHistory` holds full rows (true) or the overview's summary form (false).
   *  Left out, a given history is taken to be full, as it always was. */
  initialHistoryDetail?: boolean;
  initialLidoRewards?: AssetRow[] | null;
  initialUsdJpyRates?: AssetRow[] | null;
  initialLatestSyncRun?: AssetRow | null;
} = {}) {
  const [view, setView] = useState<AssetView>(initialView);

  // state/history/lidoRewards/usdJpyRates/latestSyncRun live here (not inside
  // each view) so switching tabs -- which unmounts the previous view -- does
  // not lose data already fetched, and a period selection made in one view can
  // be served from the same cache another view already warmed. Mirrors the
  // legacy app's single shared `state`/`history`/`historyDays` module state.
  const [state, setState] = useState<AssetStateData | null>(initialState);
  const [history, setHistory] = useState<AssetHistoryData | null>(initialHistory);
  const [historyDays, setHistoryDays] = useState(initialHistory ? 90 : 0);
  // Full rows (tokens, positions) are only read by the per-currency history; the
  // overview needs just ids, dates and totals. Until the currency view is opened
  // `history` is the small summary form.
  const [historyDetail, setHistoryDetail] = useState(initialHistoryDetail ?? initialHistory != null);
  // What `history` covers, kept where the async fetches below can read it without a stale closure.
  const coverage = useRef({ days: initialHistory ? 90 : 0, detail: initialHistoryDetail ?? initialHistory != null });
  const [lidoRewards, setLidoRewards] = useState<AssetRow[] | null>(initialLidoRewards);
  const [usdJpyRates, setUsdJpyRates] = useState<AssetRow[] | null>(initialUsdJpyRates);
  const [latestSyncRun, setLatestSyncRun] = useState<AssetRow | null>(initialLatestSyncRun);
  // localDate()/formatDate() are timezone-dependent; see manage-asset-overview.tsx.
  const today = useSyncExternalStore(subscribeNoop, localDate, emptyString);

  const skipInitialFetch = useRef(initialState != null && initialHistory != null);
  useEffect(() => {
    if (skipInitialFetch.current) return;
    let cancelled = false;
    (async () => {
      // No server-rendered data: load what the first view needs, as the pre-RSC page did.
      const currencyFirst = initialView === "currency";
      try {
        const [nextState, nextHistory, rewards, rates, sync] = await Promise.all([
          fetch("/api/manage-asset/state", { cache: "no-store" }).then((response) => response.json()),
          fetch(`/api/manage-asset/history?days=90${currencyFirst ? "" : "&summary=1"}`, { cache: "no-store" }).then((response) => response.json()),
          currencyFirst ? fetchRows("/api/lido-rewards") : Promise.resolve(null),
          currencyFirst ? fetchRows("/api/usd-jpy-rates") : Promise.resolve(null),
          fetch("/api/manage-asset/sync", { cache: "no-store" }).then((response) => (response.ok ? response.json() : { latest: null })).catch(() => ({ latest: null })),
        ]);
        if (cancelled) return;
        setState(nextState as AssetStateData);
        setHistory(nextHistory as AssetHistoryData);
        setHistoryDays(90);
        setHistoryDetail(currencyFirst);
        coverage.current = { days: 90, detail: currencyFirst };
        if (rewards && rates) {
          setLidoRewards(rewards);
          setUsdJpyRates(rates);
          extrasLoaded.current = true;
        }
        setLatestSyncRun((sync as { latest?: AssetRow | null }).latest ?? null);
      } catch {
        /* leave empty; the views render their own empty states */
      }
    })();
    return () => { cancelled = true; };
  }, [initialView]);

  // ?days= is only re-fetched when a requested period needs more than is
  // cached (app-ui.js's ensureHistory), shared across every view that asks.
  // `detail` asks for the full rows the per-currency history reads; without it
  // the summary form is enough (and is what the overview loads). Resolves true
  // when what was asked for is now held.
  //
  // Every value it reads lives in `coverage` (a ref), so the function stays the
  // same across renders -- the currency view lists it in an effect's
  // dependencies, and a new identity each render would re-run that effect --
  // and two overlapping fetches cannot clobber each other: a response that
  // covers less than what is already held (a slow summary landing after the
  // full rows) is dropped.
  const ensureHistory = useCallback(async (period: Period, detail = false): Promise<boolean> => {
    const need = neededDays(period);
    const held = coverage.current;
    if (need <= held.days && (!detail || held.detail)) return true;
    const days = Math.max(need, held.days);
    const wantDetail = detail || held.detail;
    try {
      const response = await fetch(`/api/manage-asset/history?days=${days === Infinity ? "all" : days}${wantDetail ? "" : "&summary=1"}`, { cache: "no-store" });
      if (!response.ok) return false;
      const next = await response.json() as AssetHistoryData;
      const now = coverage.current;
      const weaker = (now.detail && !wantDetail) || days < now.days;
      if (!weaker) {
        coverage.current = { days, detail: wantDetail };
        setHistory(next);
        setHistoryDays(days);
        setHistoryDetail(wantDetail);
      }
      return coverage.current.days >= need && (!detail || coverage.current.detail);
    } catch {
      return false; /* keep the existing history on failure */
    }
  }, []);

  // The Lido rewards and the FX rates are only read by the currency view, so they
  // are fetched the first time it is opened -- once, and shared by every caller.
  // A failed request degrades to "no rows", as it always did.
  const extrasLoaded = useRef(initialLidoRewards != null && initialUsdJpyRates != null);
  const extrasPromise = useRef<Promise<void> | null>(null);
  const ensureCurrencyData = useCallback((): Promise<void> => {
    if (extrasLoaded.current) return Promise.resolve();
    extrasPromise.current ??= Promise.all([fetchRows("/api/lido-rewards"), fetchRows("/api/usd-jpy-rates")]).then(([rewards, rates]) => {
      setLidoRewards(rewards);
      setUsdJpyRates(rates);
      extrasLoaded.current = true;
    });
    return extrasPromise.current;
  }, []);

  return (
    <main className="portal-shell asset-workspace">
      <PortalHeader title="Manage Asset" active="/manage-asset">
        <nav className="asset-tabs" aria-label="Manage Asset メニュー">
          {assetViews.map(([id, label]) => (
            <button key={id} type="button" className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}>
              {label}
            </button>
          ))}
        </nav>
      </PortalHeader>
      {/* Every view stays mounted and is only CSS-hidden when inactive (the
          `hidden` attribute), matching how the legacy SPA kept every section in
          the DOM and toggled `.view.active`. Unmounting on tab switch would
          reset each view's own selection (chosen currency, period, expanded
          row) every time the user came back to it. */}
      <div hidden={view !== "overview"}>
        <AssetOverview state={state} history={history} today={today} ensureHistory={ensureHistory} />
      </div>
      <div hidden={view !== "locations"}>
        <LocationsView state={state} today={today} />
      </div>
      <div hidden={view !== "currency"}>
        <CurrencyView state={state} history={history} historyDays={historyDays} historyDetail={historyDetail} active={view === "currency"} lidoRewards={lidoRewards} usdJpyRates={usdJpyRates} today={today} ensureHistory={ensureHistory} ensureCurrencyData={ensureCurrencyData} />
      </div>
      <div hidden={view !== "update"}>
        <SyncView latestRun={latestSyncRun} today={today} />
      </div>
      <div hidden={view !== "settings"}>
        <SettingsView state={state} />
      </div>
    </main>
  );
}
