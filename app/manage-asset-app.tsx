"use client";

import { PortalHeader } from "./portal-nav";

export function ManageAssetApp() {
  return <main className="portal-shell manage-asset-host">
    <PortalHeader kicker="PRIVATE LEDGER" title="Manage Asset" active="/manage-asset" />
    <iframe className="manage-asset-original" src="/manage-asset-original/index.html" title="Manage Asset" />
  </main>;
}
