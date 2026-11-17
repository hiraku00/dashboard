"use client";

/** ルートのレイアウト自体が失敗したときの最後の受け皿（error.tsx はレイアウトの内側にしか効かない）。
 *  レイアウトが無いので、自分で html と body を持ち、globals.css に頼らない。 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="ja">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "48px 24px", textAlign: "center" }}>
        <h1 style={{ fontSize: 20 }}>表示できませんでした</h1>
        <p>少し待ってから、もう一度お試しください。</p>
        <button type="button" onClick={reset} style={{ padding: "8px 18px", fontSize: 15 }}>もう一度読み込む</button>
      </body>
    </html>
  );
}
