"use client";

import { useEffect, useRef, useState } from "react";
import { PortalHeader } from "./portal-nav";

const assetViews = [
  ["overview", "資産概要"],
  ["locations", "保管場所"],
  ["currency", "通貨推移"],
  ["update", "データ更新"],
  ["settings", "設定"],
] as const;

/** The view ids the embedded legacy app knows (its nav `data-view` values). */
export type AssetView = (typeof assetViews)[number][0];

export function ManageAssetApp({ initialView = "overview" }: { initialView?: AssetView } = {}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(900);
  // The iframe is told which view to show in onLoad, so starting here is what
  // makes /manage-asset/settings and friends open on their own section.
  const [view, setView] = useState<AssetView>(initialView);
  const scrollToViewStart = () => {
    const target = frame.current;
    const chrome = document.querySelector<HTMLElement>(
      ".manage-asset-host .portal-chrome",
    );
    if (!target) return;
    window.scrollTo({
      top: Math.max(
        0,
        target.getBoundingClientRect().top +
          window.scrollY -
          (chrome?.getBoundingClientRect().height ?? 0),
      ),
      behavior: "smooth",
    });
  };
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
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.data?.type !== "manage-asset:view"
      )
        return;
      if (assetViews.some(([id]) => id === event.data.view)) {
        setView(event.data.view);
        scrollToViewStart();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  const postView = (nextView: AssetView) =>
    frame.current?.contentWindow?.postMessage(
      { type: "manage-asset:view", view: nextView },
      window.location.origin,
    );
  // The iframe is server-rendered, so it usually finishes loading before React
  // hydrates and its onLoad handler never fires. Posting the view from an
  // effect as well is what makes /manage-asset/settings and friends open on
  // their own section; onLoad still covers the reverse order.
  useEffect(() => {
    postView(view);
  }, [view]);
  const selectView = (nextView: AssetView) => {
    setView(nextView);
    postView(nextView);
    scrollToViewStart();
  };
  return (
    <main className="portal-shell manage-asset-host">
      <PortalHeader title="Manage Asset" active="/manage-asset">
        <nav className="asset-section-nav" aria-label="Manage Asset メニュー">
          {assetViews.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={view === id ? "active" : ""}
              aria-current={view === id ? "page" : undefined}
              onClick={() => selectView(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      </PortalHeader>
      <iframe
        ref={frame}
        className="manage-asset-original"
        style={{ height }}
        src="/manage-asset-original/index.html?embedded=1"
        title="Manage Asset"
        onLoad={() => postView(view)}
      />
    </main>
  );
}
