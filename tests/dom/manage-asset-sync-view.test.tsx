import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SyncView } from "@/app/manage-asset-sync-view";
import type { AssetRow } from "@/app/lib/manage-asset-core";

// The last sync's status is shown as a Japanese label. A partly failed run
// (completed_with_errors) used to appear under its raw English status name.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const run = (status: string): AssetRow => ({ status, received_at: "2026-11-17T00:00:00Z", source_count: 17, success_count: 15, error_count: 2 } as unknown as AssetRow);

test.each([
  ["completed", "完了"],
  ["completed_with_errors", "一部失敗"],
  ["failed", "失敗"],
  ["started", "実行中"],
])("the %s status is labelled %s", (status, label) => {
  vi.stubGlobal("fetch", () => Promise.resolve(new Response("{}", { status: 200 })));
  render(<SyncView latestRun={run(status)} today="2026-11-17" active={false} />);
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.queryByText(status)).toBeNull();
});
