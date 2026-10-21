"use client";

import type { ReactNode } from "react";

/** Watch List・ちきりんオプチャの一覧で共通の部品。見出し(件数)・件数を兼ねた絞り込み・切り替えボタン・ページ移動・空の表示。
 *  一覧ごとに作りがずれていた(ページ番号の出し方、件数の帯の有無など)ので、ここにそろえる。 */

/** 「45 件中 21–30」。 */
export function rangeText(total: number, page: number, pageSize: number): string {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  return `${total} 件中 ${from}–${Math.min(page * pageSize, total)}`;
}

/** 見出し: 題と件数。絞り込み中なら「条件をクリア」を出す。children は件数の後ろに添える補足(タイムゾーンなど)。 */
export function ListHeading({ id, title, loading, total, page, pageSize, onClear, children }: {
  id: string; title: string; loading: boolean; total: number; page: number; pageSize: number; onClear?: () => void; children?: ReactNode;
}) {
  return <div className="library-heading">
    <h2 id={id}>{title}</h2>
    <span className="result-count">
      {onClear && <button type="button" className="clear-filters" onClick={onClear}>条件をクリア</button>}
      {loading ? "読み込み中" : rangeText(total, page, pageSize)}{children}
    </span>
  </div>;
}

export type CountOption<K extends string> = { key: K; label: string; count?: number; note?: string; title?: string };

/** 件数を兼ねた絞り込み: 各項目の件数を見せ、押すとその条件で絞り込む(押されている項目が今の絞り込み)。
 *  件数は絞り込み前の全体の数(どの条件でも同じ数字が出る)。件数が分からないときは「—」。 */
export function CountFilter<K extends string>({ label, options, value, onChange }: {
  label: string; options: Array<CountOption<K>>; value: K; onChange: (key: K) => void;
}) {
  return <div className="summary-grid count-filter" role="group" aria-label={label}>
    {options.map((o) => <button type="button" key={o.key} className={o.key === value ? "summary-card is-active" : "summary-card"} aria-pressed={o.key === value} title={o.title} onClick={() => onChange(o.key)}>
      <span>{o.label}</span><strong>{o.count ?? "—"}</strong><small>{o.note ?? "件"}</small>
    </button>)}
  </div>;
}

/** 少ない選択肢の切り替え(並び順・視聴など)。選択肢が多いもの(種別・人物)は select を使う。 */
export function ChipGroup<K extends string>({ label, options, value, onChange, title }: {
  label: string; options: Array<{ key: K; label: string; title?: string }>; value: K; onChange: (key: K) => void; title?: string;
}) {
  return <div className="chip-group" role="group" aria-label={label} title={title}>
    {options.map((o) => <button type="button" key={o.key} className={o.key === value ? "chip is-active" : "chip"} aria-pressed={o.key === value} title={o.title} onClick={() => onChange(o.key)}>{o.label}</button>)}
  </div>;
}

/** ページ移動: 最初・前・今・次・最後のページ番号を出す(間は「…」)。1ページしかなければ出さない。 */
export function Pagination({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (page: number) => void }) {
  if (totalPages <= 1) return null;
  const pages = [...new Set([1, page - 1, page, page + 1, totalPages])].filter((n) => n >= 1 && n <= totalPages).sort((x, y) => x - y);
  return <nav className="pagination" aria-label="ページ移動">
    <button type="button" aria-label="前のページ" disabled={page === 1} onClick={() => onChange(page - 1)}>‹</button>
    {pages.map((value, index) => <span className="page-number" key={value}>{index > 0 && value - pages[index - 1] > 1 && <i aria-hidden="true">…</i>}<button type="button" className={value === page ? "current-page" : ""} aria-current={value === page ? "page" : undefined} onClick={() => onChange(value)}>{value}</button></span>)}
    <button type="button" aria-label="次のページ" disabled={page === totalPages} onClick={() => onChange(page + 1)}>›</button>
  </nav>;
}

/** 該当が無いときの表示。 */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty-state"><strong>{title}</strong>{children}</div>;
}
