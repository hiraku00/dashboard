"use client";

import type { AssetRow } from "@/app/lib/manage-asset-core";
import { formatDate } from "@/app/lib/manage-asset-format";

const statusLabels: Record<string, string> = { started: "実行中", completed: "完了", failed: "失敗" };

/** データ更新は読み取り専用。外部APIの取得・同期はMac側アプリだけが行い、この
 *  ポータルは資産スナップショットを受け取るだけ（/api/manage-asset/sync は
 *  Macコレクタの取り込みAPIで、UIのボタンではない）。レガシーUIにあった個別/一括
 *  更新ボタンは /api/wallets・/api/sources 系の書き込みルートを叩いていたが、
 *  そのルート自体がこのポータルに存在しないため持ち込まない。 */
export function SyncView({ latestRun, today }: { latestRun: AssetRow | null; today: string }) {
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
