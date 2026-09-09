"use client";

import { useEffect, useRef, useState } from "react";
import { PortalHeader } from "./portal-nav";
import { AssetOverview, type AssetHistoryData, type AssetStateData } from "./manage-asset-overview";

const assetViews = [
  ["overview", "資産概要"],
  ["locations", "保管場所"],
  ["currency", "通貨推移"],
  ["update", "データ更新"],
  ["settings", "設定"],
] as const;

/** The view ids the embedded legacy app knows (its nav `data-view` values). */
export type AssetView = (typeof assetViews)[number][0];

export function ManageAssetApp({
  initialView = "overview",
  initialState = null,
  initialHistory = null,
}: {
  initialView?: AssetView;
  initialState?: AssetStateData | null;
  initialHistory?: AssetHistoryData | null;
} = {}) {
  const [view, setView] = useState<AssetView>(initialView);
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
      {view === "overview" ? (
        // Overview is the migrated native view (Issue: manage-asset RSC, phase A).
        // Seeded from the server on the /manage-asset route; other routes pass
        // null and it fetches on the client, like the pre-RSC app did.
        <AssetOverview initialState={initialState} initialHistory={initialHistory} />
      ) : (
        // Locations / currency / settings / sync still render the original app in
        // an iframe until phases B and C port them.
        <LegacyAssetFrame view={view} />
      )}
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
