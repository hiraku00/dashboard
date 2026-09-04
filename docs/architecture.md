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
- UIの表示変更は元のManage Asset/TextTube画面との互換性を確認する。
