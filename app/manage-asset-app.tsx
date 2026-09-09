"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AssetRow } from "@/app/lib/manage-asset-core";
import { localDate } from "@/app/lib/manage-asset-format";
import { neededDays, type Period } from "@/app/lib/manage-asset-chart";
import { PortalHeader } from "./portal-nav";
import { AssetOverview, type AssetHistoryData, type AssetStateData } from "./manage-asset-overview";
import { LocationsView } from "./manage-asset-locations";
import { CurrencyView } from "./manage-asset-currency";

const assetViews = [
  ["overview", "資産概要"],
  ["locations", "保管場所"],
  ["currency", "通貨推移"],
  ["update", "データ更新"],
  ["settings", "設定"],
] as const;

/** The view ids the embedded legacy app knows (its nav `data-view` values). */
export type AssetView = (typeof assetViews)[number][0];

const subscribeNoop = () => () => {};
const emptyString = () => "";

export function ManageAssetApp({
  initialView = "overview",
  initialState = null,
  initialHistory = null,
  initialLidoRewards = null,
  initialUsdJpyRates = null,
}: {
  initialView?: AssetView;
  initialState?: AssetStateData | null;
  initialHistory?: AssetHistoryData | null;
  initialLidoRewards?: AssetRow[] | null;
  initialUsdJpyRates?: AssetRow[] | null;
} = {}) {
  const [view, setView] = useState<AssetView>(initialView);

  // state/history/lidoRewards/usdJpyRates live here (not inside each view) so
  // switching tabs -- which unmounts the previous view -- does not lose data
  // already fetched, and a period selection made in one view can be served
  // from the same cache another view already warmed. Mirrors the legacy app's
  // single shared `state`/`history`/`historyDays` module state.
  const [state, setState] = useState<AssetStateData | null>(initialState);
  const [history, setHistory] = useState<AssetHistoryData | null>(initialHistory);
  const [historyDays, setHistoryDays] = useState(initialHistory ? 90 : 0);
  const [lidoRewards, setLidoRewards] = useState<AssetRow[] | null>(initialLidoRewards);
  const [usdJpyRates, setUsdJpyRates] = useState<AssetRow[] | null>(initialUsdJpyRates);
  // localDate()/formatDate() are timezone-dependent; see manage-asset-overview.tsx.
  const today = useSyncExternalStore(subscribeNoop, localDate, emptyString);

  const skipInitialFetch = useRef(initialState != null && initialHistory != null);
  useEffect(() => {
    if (skipInitialFetch.current) return;
    let cancelled = false;
    (async () => {
      try {
        const [nextState, nextHistory, rewards, rates] = await Promise.all([
          fetch("/api/manage-asset/state", { cache: "no-store" }).then((response) => response.json()),
          fetch("/api/manage-asset/history?days=90", { cache: "no-store" }).then((response) => response.json()),
          fetch("/api/lido-rewards", { cache: "no-store" }).then((response) => (response.ok ? response.json() : { rows: [] })).catch(() => ({ rows: [] })),
          fetch("/api/usd-jpy-rates", { cache: "no-store" }).then((response) => (response.ok ? response.json() : { rows: [] })).catch(() => ({ rows: [] })),
        ]);
        if (cancelled) return;
        setState(nextState as AssetStateData);
        setHistory(nextHistory as AssetHistoryData);
        setHistoryDays(90);
        setLidoRewards(((rewards as { rows?: AssetRow[] }).rows ?? []));
        setUsdJpyRates(((rates as { rows?: AssetRow[] }).rows ?? []));
      } catch {
        /* leave empty; the views render their own empty states */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ?days= is only re-fetched when a requested period needs more than is
  // cached (app-ui.js's ensureHistory), shared across every view that asks.
  async function ensureHistory(period: Period) {
    const need = neededDays(period);
    if (need <= historyDays) return;
    try {
      const response = await fetch(`/api/manage-asset/history?days=${period === "all" ? "all" : need}`, { cache: "no-store" });
      if (!response.ok) return;
      setHistory(await response.json());
      setHistoryDays(need);
    } catch {
      /* keep the existing history on failure */
    }
  }

  return (
    <main className="portal-shell asset-workspace">
      <PortalHeader title="Manage Asset" active="/manage-asset" />
      <nav className="asset-tabs" aria-label="Manage Asset メニュー">
        {assetViews.map(([id, label]) => (
          <button key={id} type="button" className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}>
            {label}
          </button>
        ))}
      </nav>
      {/* The three migrated views stay mounted and are only CSS-hidden when
          inactive (the `hidden` attribute), matching how the legacy SPA kept
          every section in the DOM and toggled `.view.active`. Unmounting on
          tab switch would reset each view's own selection (chosen currency,
          period, expanded row) every time the user came back to it. */}
      <div hidden={view !== "overview"}>
        <AssetOverview state={state} history={history} today={today} ensureHistory={ensureHistory} />
      </div>
      <div hidden={view !== "locations"}>
        <LocationsView state={state} today={today} />
      </div>
      <div hidden={view !== "currency"}>
        <CurrencyView state={state} history={history} lidoRewards={lidoRewards} usdJpyRates={usdJpyRates} today={today} ensureHistory={ensureHistory} />
      </div>
      {view === "settings" || view === "update" ? (
        // Settings / data-update views: not yet migrated (Phase C).
        <LegacyAssetFrame view={view} />
      ) : null}
    </main>
  );
}

/** The not-yet-migrated views, still served by public/manage-asset-original.
 *  Posts the requested view once loaded and follows the iframe body's height. */
function LegacyAssetFrame({ view }: { view: AssetView }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(900);
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ type: "manage-asset:view", view }, window.location.origin);
  }, [view]);
  useEffect(() => {
    const resize = () => {
      const body = frame.current?.contentDocument?.body;
      if (body) setHeight(Math.max(700, body.scrollHeight + 12));
    };
    window.addEventListener("message", resize);
    const timer = window.setInterval(resize, 500);
    return () => {
      window.removeEventListener("message", resize);
      window.clearInterval(timer);
    };
  }, []);
  return (
    <iframe
      ref={frame}
      className="manage-asset-original"
      style={{ height }}
      src="/manage-asset-original/index.html?embedded=1"
      title="Manage Asset"
      onLoad={() => frame.current?.contentWindow?.postMessage({ type: "manage-asset:view", view }, window.location.origin)}
    />
  );
}
