# デプロイとAccess設定

## 前提

- Cloudflareアカウントへログイン済み
- `wrangler.jsonc` のD1/R2 bindingが現行環境を指している
- 本番データのバックアップ済み
- Accessの通常認証とcollector用Service Authを区別して管理

## D1 migration

migrationを確認してから本番へ適用します。

```bash
npx wrangler d1 migrations list hiraku-watch-list --remote
npx wrangler d1 migrations apply hiraku-watch-list --remote
```

migration適用後は、主要APIと既存画面を確認します。既存データの破壊や大量更新を伴うmigrationは、事前バックアップと復旧手順を用意します。

## Worker deploy

本番WorkerはGitHub Actionsから自動デプロイします。`main`へのpush、つまりPRのmergeが成功すると、次の順序で実行されます。

1. Node.js 22.13.0をセットアップ
2. `npm ci`でlockfileどおりに依存関係をインストール
3. `npm test`でbuildとテストを実行
4. テスト成功時だけ `wrangler deploy --config wrangler.jsonc` を実行

workflowは `.github/workflows/deploy-production.yml` で管理します。デプロイの同時実行は1件に制限し、先行デプロイが完了してから次のデプロイを開始します。

GitHubのproduction Environmentには、次のSecretsを登録します。値はリポジトリへ保存しません。

- `CLOUDFLARE_API_TOKEN`: 本番Workerのデプロイに必要な権限だけを付与したCloudflare API Token
- `CLOUDFLARE_ACCOUNT_ID`: `wrangler.jsonc` のWorkerが属するCloudflareアカウントID

API TokenはWorkersのデプロイ権限に絞り、不要なD1/R2管理権限やAccount全体の編集権限を付与しません。

既存の手動コマンドは障害対応・Actionsの再現確認用に残します。

```bash
npm test
npm run build
npx wrangler deploy --config wrangler.jsonc
```

D1 migrationはWorkerデプロイに含めません。migrationが必要な変更では、バックアップ、migration確認、適用、画面確認を別の手順として実行します。

デプロイ後に次を確認します。

- `/` がAccess認証後に表示される
- Watch Listの一覧/APIが取得できる
- TextTube本文、Markdown表、Mermaid、目次が表示される
- Manage Assetの最新日付、stETH、通貨推移、保管場所が表示される
- `/settings/storage` に利用状況が表示される

## Access

### ブラウザ

Workerの本番URLをAccess Applicationに登録し、個人アカウントだけを許可するポリシーを設定します。公開URLだけでD1/R2へ到達できる構成にしません。

### collector

collectorの同期エンドポイントにService Authを要求します。client ID/secretはMacのKeychainに保存し、collectorの環境変数には実行時だけ渡します。

Keychainサービス:

- `manage-asset:portal-sync`

collector側の設定:

```text
PORTAL_URL=https://dashboard.hiraku00.workers.dev
PORTAL_SYNC_CLIENT_ID=<Keychainから実行時に設定>
```

secret値をファイルに固定保存せず、Service Tokenを再発行した場合はKeychainとAccess側を同時に更新します。

## R2

`wrangler.jsonc` の `FILES` bindingが `hiraku-portal-files` を指します。本文・原本の書き込み後、D1のrevision/台帳との対応を確認します。R2の利用量は日次reconciliationで確認し、上限に近づいた場合は新規原本の保持期間や不要オブジェクトを見直します。

## ロールバック

Workerの表示/API不具合は直前のWorker versionへ戻します。D1 migrationは自動逆戻しせず、必要なら逆migrationまたはバックアップからの復旧を計画します。R2オブジェクトは削除前に参照元とバックアップを確認します。
