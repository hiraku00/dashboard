"use client";

import { useState } from "react";

/** 折りたたみ: 長い本文は最初の数行だけ見せ、押すと全文にする。full なら最初から全文。 */
export function Body({ text, full = false }: { text: string; full?: boolean }) {
  const [open, setOpen] = useState(full);
  const long = !full && (text.length > 280 || text.split("\n").length > 7);
  return <div className="chikirin-body">
    <p className={long && !open ? "chikirin-text is-clamped" : "chikirin-text"}>{text}</p>
    {long && <button type="button" className="chikirin-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "閉じる" : "全文を表示"}</button>}
  </div>;
}
