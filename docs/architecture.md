# アーキテクチャ

## 全体図

```text
┌──────────────┐       ┌──────────────────────┐
│ Browser      │──────▶│ Cloudflare Access    │
└──────────────┘       └──────────┬───────────┘
                                  ▼
                         ┌──────────────────┐
                         │ Worker           │
                         │ Vinext/React/API │
                         └──────┬─────┬─────┘
                                │     │
                         ┌──────▼─┐ ┌─▼────┐
                         │ D1     │ │ R2   │
                         └────────┘ └──────┘

┌──────────────┐  Keychain  ┌──────────────┐  Service Auth  ┌──────────────┐
│ launchd      │───────────▶│ Mac collector│──────────────▶│ Worker sync   │
└──────────────┘            └──────────────┘               └──────────────┘
```

## Cloudflare側

### Worker

`worker/auth-wrapper.ts` がWorkerの入口です。Access経由の認証済みリクエストをVinextアプリへ渡し、静的アセットとAPIを同一オリジンで提供します。

### D1

`hiraku-watch-list` は検索、一覧、集計、履歴、同期状態などの構造化データを保存します。スキーマの正は `db/index.ts` の `ensureSchema()` で、これが新規DBに対して全テーブルとインデックスを作成します。既存DBへ適用済みのSQLは `migrations/` にあり、D1の `d1_migrations` テーブルで管理されます（wrangler の `migrations_dir`）。スキーマ変更時は**両方**の更新が必要です。

### R2

`hiraku-portal-files` はTextTube本文、revision、インポート原本などのオブジェクトを保存します。D1にはR2キーとメタデータを保存し、本文検索に必要な構造化情報だけをD1へ置きます。

### Access

ブラウザは通常のAccess認証、collectorはService Authで保護します。Accessの設定はアプリケーション側のURLとポリシーを分けて管理します。

## Mac側

collectorは `collector/` にあり、外部APIキーをmacOS Keychainから読み出します。launchdは定時実行を担当し、collectorは取得、正規化、D1同期用payloadの作成、Workerへの送信を行います。

秘密情報はMacから外へ送らず、Workerへ送るのは資産スナップショットと同期メタデータだけです。

## 主要なデータ境界

| データ | 生成元 | 保存先 | ブラウザ表示 |
| --- | --- | --- | --- |
| Watch List項目 | ブラウザ/移行スクリプト | D1 | 直接表示 |
| To Doカード・繰り返しテンプレート | ブラウザ/日別ボード取得 | D1 | 直接表示 |
| TextTubeメタデータ | ブラウザ/移行スクリプト | D1 | 一覧・検索 |
| TextTube本文 | ブラウザ/移行スクリプト | R2 | Worker経由 |
| 資産スナップショット | Mac collector | D1 | 集計・履歴 |
| 外部APIキー | macOS Keychain | Macのみ | 表示しない |

## 変更時のルール

- D1の列変更はmigrationを追加する。
- R2のキー形式を変える場合は既存revisionの読み取り互換性を維持する。
- collectorのpayload変更はWorker APIと同時に検証する。
- UIの表示変更はTextTubeの元デザインとの互換性を確認する。Manage Assetは`app/lib/manage-asset-core.ts`の純関数群と`tests/manage-asset-core.test.mjs`が計算ロジックの正であり、表示側の変更もこのテストで数値の同値性を担保する。

## D1へのSQLの置き場所

読み取りは `app/lib/queries/*.ts` に一本化する。API routeのGETと対応するServer Componentが同じ集計・一覧ロジックを呼ぶことで、「ページとAPIで表示がずれる」種類のバグ（例: PR #132）を防ぐのが目的（各ファイルの冒頭コメント参照）。`app/lib/queries/` に新しい読み取りを書き込みロジックと混ぜない（`app/lib/queries/todo.ts` の冒頭コメントに理由あり）。

書き込み（POST/PATCH/DELETE、および同期・移行系エンドポイント）のSQLは、当面は各 `app/api/**/route.ts` に直接置いたままでよい。書き込みは読み取りと違い「複数の呼び出し元が同じ結果を期待する」場面が少なく、無理に共通化するとエンドポイントごとの細かい違い（バリデーション、レスポンス形）を吸収するためのオプション引数が増えて可読性が落ちる。書き込みロジックが2箇所以上から呼ばれる、あるいは1つのroute.ts内で明らかに肥大化した場合に、その時点で個別に切り出す。
