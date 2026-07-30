# Dashboard

Watch List、TextTube、Manage Assetを一つのCloudflare上で管理する、個人用ポータルです。
ブラウザからはCloudflare Accessで保護されたWorkerへアクセスし、永続データはD1、Markdown本文や大きなファイルはR2に保存します。

## できること

- **Watch List**: 番組・記事・音声・映画などの視聴候補を、検索、絞り込み、優先度、ステータス、リンク付きで管理
- **TextTube**: 動画・音声・記事のライブラリ、詳細Markdown、目次、Markdown表、Mermaid図を含む本文表示、Studio編集
- **Manage Asset**: 資産総額、資産配分、保有資産、保管場所、通貨推移、履歴、設定、データ更新を表示
- **ローカル資産取得**: APIキーをmacOS Keychainに保持したローカルcollectorが各サービスから取得し、スナップショットだけをCloudflareへ同期
- **ストレージ管理**: D1/R2の利用状況、カテゴリ別容量、日次集計、上限アラートを確認

## 本番環境

- Worker: <https://dashboard.hiraku00.workers.dev>
- 主な画面: `/`, `/watch-list`, `/text-tube`, `/manage-asset`, `/settings/storage`
- 本番データ: Cloudflare D1 `hiraku-watch-list` / R2 `hiraku-portal-files`

本番URLはCloudflare Accessで保護されています。Accessの認証・セッションがない環境からは画面/APIを利用できません。

## 画面構成

| パス | 機能 |
| --- | --- |
| `/` | ポータルホーム。各機能への導線とデータ基盤の状態 |
| `/watch-list` | Watch Listの検索、フィルタ、ページング、登録・編集・削除、インポート/エクスポート |
| `/text-tube` | TextTubeライブラリ。検索、並び替え、ステータス管理、詳細表示への導線 |
| `/text-tube/studio` | TextTubeの作成・編集画面 |
| `/text-tube/watch/:id` | TextTube本文の読書画面。Markdown、GFM表、目次アンカー、Mermaidを表示 |
| `/manage-asset` | Manage Assetホーム。総資産、資産推移、資産配分、保有資産 |
| `/manage-asset/locations` | 保管場所ごとの資産内訳 |
| `/manage-asset/currencies` | 通貨ごとの資産推移と履歴 |
| `/manage-asset/sync` | データ取得・同期状況、古いデータ、手動同期状態 |
| `/manage-asset/settings` | Manage Asset表示・同期設定 |
| `/settings/storage` | D1/R2の利用状況とストレージ管理 |

各機能画面には共通ポータルヘッダーが表示されます。Manage Assetの中心画面は、既存UIの表示仕様を維持した静的アセットをベースに、ポータルのナビゲーションを外側から追加する構成です。

## システム構成

```text
ブラウザ
  │ Cloudflare Access
  ▼
Cloudflare Worker (Vinext/React)
  ├─ UI: Watch List / TextTube / Manage Asset / Storage
  ├─ API: D1・R2への認証済みアクセス
  ├─ D1: 検索・一覧・履歴・スナップショットのメタデータ
  └─ R2: Markdown本文・インポート原本・大きなファイル

Mac (launchd)
  ├─ Keychain: APIキー、同期用Service Token
  ├─ collector: 各サービスから資産データを取得
  └─ HTTPS + Access Service Auth: スナップショットをWorkerへ同期
```

詳細は以下を参照してください。

- [システム概要](docs/system-overview.md)
- [アーキテクチャ](docs/architecture.md)
- [画面・機能一覧](docs/routes-and-features.md)
- [API一覧](docs/api-reference.md)
- [データモデル](docs/data-model.md)
- [Manage Asset運用](docs/manage-asset.md)
- [TextTube運用](docs/text-tube.md)
- [デプロイとAccess設定](docs/deployment-and-access.md)
- [日次運用・障害対応](docs/operations.md)
- [データ移行](docs/migration.md)
- [セキュリティ方針](SECURITY.md)

## ローカル開発

```bash
npm ci
npm run dev
```

別のターミナルで検証します。

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

本番到達性を確認する場合は`npm run smoke:production`を実行します。Access認証前のリダイレクトも正常応答として扱います。

ローカルのWorkerは、設定に応じてD1/R2のローカルまたはリモート接続を使います。APIキーやService Tokenをソースコード、`.env`、Wrangler設定へ書き込まないでください。

## デプロイ

Pull RequestではGitHub Actionsがlint、TypeScriptコンパイラチェック、build・回帰テストを実行します。mainへのmerge後は同じ検証に加えて、本番Workerのデプロイと主要ルートのスモークテストを実行します。デプロイ状態はGitHubのActions画面とproduction Environmentで確認します。

必要なSecretsはGitHubのproduction Environmentに登録します。

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

手動で再現・復旧する場合は、先にテストと差分確認を行います。

```bash
npx wrangler d1 migrations apply hiraku-watch-list --remote
npx wrangler deploy --config wrangler.jsonc
```

Cloudflare Access、D1、R2、collector/launchdの設定手順は[デプロイとAccess設定](docs/deployment-and-access.md)にまとめています。

## データ移行

既存データの移行スクリプトは `scripts/` にあります。

- `scripts/import-watch-list.mjs`: Watch List Markdown → D1
- `scripts/import-text-tube.mjs`: TextTubeデータ → D1/R2
- `scripts/import-manage-asset-history.mjs`: Manage Asset履歴 → D1
- `scripts/sync-manage-asset.mjs`: ローカル資産スナップショット → Worker

実行条件、冪等性、バックアップ、失敗時の確認方法は[データ移行](docs/migration.md)を参照してください。

## リポジトリ名について

GitHubリポジトリは [`hiraku00/dashboard`](https://github.com/hiraku00/dashboard) です。初期機能名の `watch-list` から、現在のDashboard構成に合わせて変更しました。

ただし、リポジトリ名変更はGitHubのURL・remote・ドキュメント・CI参照を更新する作業であり、Cloudflare Worker/D1/R2のリソース名変更とは別です。まずは既存のCloudflareリソース名を維持したままドキュメントを整備し、改名を行う場合は別の変更として実施します。

## セキュリティ

コミットしてはいけないもの:

- APIキー、アクセストークン、Cloudflare Access Service Token
- `.env*`、`.dev.vars*`、Keychainのダンプ、実データのバックアップ
- Wranglerのローカル状態、個人のログ、取得元サービスの生データ

collectorの秘密情報はmacOS Keychainで管理し、Cloudflareへは取得結果のスナップショットだけを送信します。詳細は[SECURITY.md](SECURITY.md)を確認してください。
