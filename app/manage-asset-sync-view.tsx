"use client";

import { useEffect, useState } from "react";
import type { AssetRow } from "@/app/lib/manage-asset-core";
import { formatDate } from "@/app/lib/manage-asset-format";

const statusLabels: Record<string, string> = { started: "実行中", completed: "完了", failed: "失敗" };

/** データ更新のAPI取得そのものは読み取り専用（取引所追加・認証情報変更・ウォレット
 *  編集はMac側アプリだけが書き込む）。「今すぐ再取得」ボタンだけは例外で、/api/
 *  manage-asset/sync に依頼(request_resync)を書き込む -- APIキーはMacのKeychain
 *  にしかないので、ここで書けるのは「依頼した事実」だけ。Mac側collectorが自分の
 *  60秒ごとのlaunchdティックでこの依頼を見つけ、全source再取得後に
 *  fulfill_resyncで消す。ポーリングはこのポータル側ではなくMac側が持つ。 */
export function SyncView({ latestRun, today, active }: { latestRun: AssetRow | null; today: string; active: boolean }) {
  const [pending, setPending] = useState<{ requested_at?: string } | null>(null);
  const [status, setStatus] = useState<"idle" | "sending" | "error">("idle");

  // タブが隠れている間はポーリングしない -- このビューは常時マウントされるため
  // （manage-asset-app.tsx参照）、`active`で絞らないと他タブ表示中も15秒おきに
  // 無駄なfetchが走る。
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const check = () =>
      fetch("/api/manage-asset/sync", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((body) => {
          if (cancelled || !body) return;
          setPending((body as { pendingResyncRequest?: { requested_at?: string } | null }).pendingResyncRequest ?? null);
        })
        .catch(() => {});
    check();
    const interval = setInterval(check, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [active]);

  const requestResync = async () => {
    setStatus("sending");
    try {
      const response = await fetch("/api/manage-asset/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request_resync" }),
      });
      if (!response.ok) throw new Error();
      const body = (await response.json()) as { request?: { requested_at?: string } };
      setPending(body.request ?? null);
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  };

  return (
    <section className="asset-panel sync-panel">
      <div className="panel-heading">
        <div>
          <h2>データ更新</h2>
          <span>API取得は現在残高のみです。過去残高は保存済み記録から表示します。</span>
        </div>
      </div>
      <p className="muted-copy">
        外部APIの取得と同期はMac側アプリだけで行います。取引・送金・出金権限のないAPIキーを使い、認証情報はMacのKeychainだけへ保存されます。このポータルには資産スナップショットだけが送られます。
      </p>
      <div className="settings-item">
        <div>
          <strong>今すぐ再取得</strong>
          <span>Macが起動していれば、次の確認タイミング（1分以内）で全保管場所を再取得します。</span>
        </div>
        <button type="button" className="secondary-button" onClick={requestResync} disabled={status === "sending" || Boolean(pending)}>
          {pending ? "依頼中…" : "今すぐ再取得を依頼"}
        </button>
      </div>
      {status === "error" && <p className="muted-copy status-muted">依頼に失敗しました。もう一度お試しください。</p>}
      {latestRun ? (
        <div className="settings-list">
          <div className="settings-item">
            <div><strong>最終同期</strong><span>{today ? formatDate(latestRun.received_at) : "—"}</span></div>
            <span className={latestRun.status === "completed" ? "status-good" : "status-muted"}>
              {statusLabels[String(latestRun.status)] ?? String(latestRun.status ?? "")}
            </span>
          </div>
          <div className="settings-item">
            <div><strong>対象 / 成功 / 失敗</strong><span>{String(latestRun.source_count ?? 0)} / {String(latestRun.success_count ?? 0)} / {String(latestRun.error_count ?? 0)}</span></div>
          </div>
        </div>
      ) : (
        <p className="muted-copy">まだ同期履歴がありません。</p>
      )}
    </section>
  );
}
