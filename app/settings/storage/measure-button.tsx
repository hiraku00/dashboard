"use client";

import { useState } from "react";

/** 「今日の分を計測」ボタン(使用量画面の主な保存データ)。今日(バンコク時間)の計測が済んでいれば押せない。
 *  計測はサーバー(/api/settings/storage/measure)が今日の分の有無を確かめてから行うので、
 *  ここで押せてしまっても2回目は測らない。 */
export function MeasureButton({ measuredToday }: { measuredToday: boolean }) {
  const [state, setState] = useState<"idle" | "running" | "error">("idle");
  const [message, setMessage] = useState("");

  if (measuredToday) {
    return <button type="button" className="secondary-button usage-measure-button" disabled>今日の分は計測済み</button>;
  }

  const measure = async () => {
    setState("running");
    setMessage("");
    try {
      const response = await fetch("/api/settings/storage/measure", { method: "POST" });
      if (response.ok || response.status === 409) {
        // 計測した(または別の画面で計測済みだった)ので、記録を読み直す
        window.location.reload();
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setState("error");
      setMessage(body?.error ?? "計測できませんでした。");
    } catch {
      setState("error");
      setMessage("計測できませんでした。通信を確かめて、もう一度押してください。");
    }
  };

  return (
    <span className="usage-measure">
      <button type="button" className="secondary-button usage-measure-button" onClick={measure} disabled={state === "running"}>
        {state === "running" ? "計測中…" : "今日の分を計測"}
      </button>
      {message ? <span className="usage-measure-error" role="alert">{message}</span> : null}
    </span>
  );
}
