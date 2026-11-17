"use client";

import Link from "next/link";
import { useEffect } from "react";

/** 画面の描画中に起きた例外の受け皿。サーバー側の読み込み（D1 の一時的な障害など）が失敗したときも、
 *  白い画面や素のエラー文ではなく、やり直す手段のある画面にする。詳しい原因は画面に出さず、ログにだけ残す
 *  （error.digest は、サーバーのログと突き合わせるための印）。 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="portal-shell">
      <div className="portal-chrome">
        <header className="portal-header">
          <h1>表示できませんでした</h1>
        </header>
      </div>
      <div className="empty-state" role="alert">
        <strong>画面の読み込み中に問題が起きました。</strong>
        <p>少し待ってから、もう一度お試しください。{error.digest ? `（エラー番号: ${error.digest}）` : ""}</p>
        <button type="button" onClick={reset}>もう一度読み込む</button>{" "}
        <Link href="/" prefetch={false}>ホームへ戻る</Link>
      </div>
    </main>
  );
}
