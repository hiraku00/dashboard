# TextTube ポータル統合の実装方針

## 方向宣言

- ジョブ: 元のTextTubeと同じ情報密度・導線で、要約と詳細スクリプトを読む／管理する。
- レジスター: 主=精密、副=物語。検索・一覧・Studioは精密に、記事本文は読むリズムを優先する。
- サーフェス: web。
- パレット: 本文面 `#0f0f0f`、カード面 `#1e1e1e`、本文 `#dddddd`、TextTubeアクセント `#ff0000`、リンク `#3ea6ff`。
- タイポ: 元TextTubeのシステムサンス＋本文16px以上、本文行間1.85、本文列は元レイアウトの最大幅を維持。
- 余白リズム: 元実装の56pxヘッダー、240pxサイドバー、8px系の間隔を基準にする。
- シグネチャー: YouTube型のサムネイル一覧、内側ヘッダー、左サイドバー、記事の要約／詳細スクリプトの二段構成。
- 禁じ手: ポータル用カードUIで元TextTubeのレイアウトを置き換えること、本文を全幅にすること、機能ごとに異なるナビゲーションを作ること。

## 元コードとの対応

| 元TextTube | ポータル版 |
| --- | --- |
| `src/components/layout/Header.tsx` | `app/text-tube-app.tsx` の `TextTubeOriginalHeader` |
| `src/components/layout/Sidebar.tsx` | `app/text-tube-app.tsx` の `TextTubeOriginalSidebar` |
| `src/app/page.tsx` / `VideoList` / `VideoCard` | `app/text-tube-app.tsx` のライブラリ一覧。ルートだけ `/text-tube` に統合 |
| `src/app/watch/[id]/page.tsx` | `app/text-tube/watch/[id]/page.tsx`。データ取得先をD1/R2 APIに置換 |
| `src/app/studio/page.tsx` | `app/text-tube/studio/page.tsx`。管理APIをD1/R2 APIに置換 |
| `src/components/ui/MarkdownRenderer.tsx` | `app/text-tube/markdown-renderer.tsx`。GFM表、目次アンカー、Mermaidを維持 |

ポータルの固定ヘッダーは元TextTubeの外側に配置する。これにより、記事をスクロールしてもポータル全機能への導線が常に見える一方、TextTube内部のレイアウトは元コードの構造を保つ。

## To Do 方向宣言

- ジョブ: 今日やることを素早く把握し、迷わず着手・完了・翌日へ持ち越す。
- レジスター: 主=精密、副=親愛。日々の道具として静かに使え、未完了を責めない。
- サーフェス: web。
- パレット: 地 `#EEF0F5`、面 `#FBFBFD`、本文 `#1D1D1F`、アクセント `#0A84FF`、成功 `#16824A`、危険 `#C52A37`。
- タイポ: 意図したAppleネイティブ感として `-apple-system` / `SF Pro Display` / `Hiragino Sans`。数値にはtabular-numsを使う。
- 余白リズム: 8ptグリッド。列内8px、カード間8px、列間12px。
- モーション: 160ms ease-out。状態変化を説明するものだけを使い、reduced-motionでは停止する。
- シグネチャー: 日付を替えても同じ看板のまま、対象日の実行カードだけが入れ替わる。
- 禁じ手: Trelloの青背景を模倣すること、カード内の情報過多、色だけに依存した完了状態。
