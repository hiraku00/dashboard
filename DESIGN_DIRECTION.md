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
