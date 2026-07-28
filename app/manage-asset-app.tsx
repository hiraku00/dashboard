"use client";

import { useEffect, useRef, useState } from "react";
import { PortalHeader } from "./portal-nav";

export function ManageAssetApp() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(900);
  useEffect(() => { const resize = () => { const body = frame.current?.contentDocument?.body; if (body) setHeight(Math.max(700, body.scrollHeight + 12)); }; window.addEventListener("message", resize); const timer = window.setInterval(resize, 500); return () => { window.removeEventListener("message", resize); window.clearInterval(timer); }; }, []);
  return <main className="portal-shell manage-asset-host">
    <PortalHeader title="Manage Asset" active="/manage-asset" />
    <iframe ref={frame} className="manage-asset-original" style={{ height }} src="/manage-asset-original/index.html" title="Manage Asset" />
  </main>;
}
