"use client";

import { Fragment, useState } from "react";
import { allPositions, latestFx, locations as locationSummaries, type AssetRow } from "@/app/lib/manage-asset-core";
import { formatDate, formatQuantity, money, yen } from "@/app/lib/manage-asset-format";
import type { AssetStateData } from "./manage-asset-overview";

/** 円換算のサブ行。app-ui.js の moneyPair 相当。 */
function MoneyPair({ value, rate }: { value: number; rate: number | null }) {
  return (
    <>
      {money(value)}
      <small>{rate ? yen(value * rate) : "円換算 —"}</small>
    </>
  );
}

export function LocationsView({ state, today }: { state: AssetStateData | null; today: string }) {
  const wallets = state?.snapshots ?? [];
  const exchanges = state?.exchange_snapshots ?? [];
  const places = locationSummaries(wallets, exchanges, today);
  const total = places.reduce((sum, place) => sum + place.value, 0);
  const rate = latestFx(wallets, exchanges)?.rate ?? null;
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section className="asset-panel asset-table-panel">
      <div className="panel-heading">
        <div>
          <h2>保管場所</h2>
          <span>ウォレット、取引所、DeFiの評価額と取得状態を確認します。</span>
        </div>
      </div>
      {places.length ? (
        <div className="table-scroll">
          <table className="asset-table">
            <caption className="sr-only">保管場所一覧</caption>
            <thead>
              <tr>
                <th scope="col">保管場所</th>
                <th scope="col">種別</th>
                <th scope="col">評価額</th>
                <th scope="col">構成比</th>
                <th scope="col">最終取得</th>
                <th scope="col">状態</th>
              </tr>
            </thead>
            <tbody>
              {places.map((place) => {
                const key = String(place.id ?? place.name);
                const expanded = open === key;
                return (
                  <Fragment key={key}>
                    <tr>
                      <td>
                        <button type="button" className="table-link" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : key)}>
                          {expanded ? "▾" : "▸"} {place.name}
                        </button>
                      </td>
                      <td>{place.type}</td>
                      <td><MoneyPair value={place.value} rate={rate} /></td>
                      <td>{total ? ((place.value / total) * 100).toFixed(1) : "0.0"}%</td>
                      {/* formatDate() is timezone-dependent (see manage-asset-overview.tsx's
                          `today` comment); "" until the client has hydrated avoids a mismatch. */}
                      <td>{today ? formatDate(place.captured_at) : "—"}</td>
                      <td><span className={place.status === "最新" ? "status-good" : "status-muted"}>{place.status}</span></td>
                    </tr>
                    {expanded ? (
                      <tr>
                        <td colSpan={6}><LocationDetail name={place.name} wallets={wallets} exchanges={exchanges} rate={rate} /></td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted-copy">保管場所を追加、またはデータを取り込んでください。</p>
      )}
    </section>
  );
}

function LocationDetail({ name, wallets, exchanges, rate }: { name: string; wallets: AssetRow[]; exchanges: AssetRow[]; rate: number | null }) {
  const items = allPositions(wallets, exchanges)
    .filter((item) => item.location === name)
    .sort((a, b) => b.valueUsd - a.valueUsd);
  if (!items.length) return <p className="muted-copy">この保管場所の資産内訳はありません。</p>;
  return (
    <div className="location-detail">
      <table className="asset-table">
        <thead>
          <tr>
            <th scope="col">資産</th>
            <th scope="col">数量</th>
            <th scope="col">単価</th>
            <th scope="col">評価額</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => {
            const unit = item.quantity && item.valueUsd > 0 ? item.valueUsd / item.quantity : null;
            return (
              <tr key={`${item.symbol}-${index}`}>
                <td>{item.symbol}{item.unpriced ? <small>評価なし</small> : null}</td>
                <td>{formatQuantity(item.quantity, item.symbol)}</td>
                <td>{unit == null ? "評価なし" : <MoneyPair value={unit} rate={rate} />}</td>
                <td>{item.unpriced ? "評価なし" : <MoneyPair value={item.valueUsd} rate={rate} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
