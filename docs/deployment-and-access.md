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

1. Node.js 24.x（LTS）をセットアップ
2. `npm ci`でlockfileどおりに依存関係をインストール
3. `npm run lint`で静的解析を実行
4. `npm run typecheck`でTypeScriptコンパイラチェックを実行
5. `npm test`でbuildと回帰テストを実行
6. 検証成功時だけ `wrangler deploy --config wrangler.jsonc` を実行
7. 主要4ルートのHTTPスモークテストを実行

PR時の検証は `.github/workflows/ci.yml`、本番デプロイは `.github/workflows/deploy-production.yml` で管理します。デプロイの同時実行は1件に制限し、先行デプロイが完了してから次のデプロイを開始します。

`npm run typecheck`は、既存コードに残る意味型エラーを段階的に解消するまでの移行期間として、現在は`tsc --noEmit --noCheck`によるコンパイラ互換性チェックを実行します。厳密な意味型チェックの有効化は別途行います。

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

#### ちきりんオプチャの同期API

`collector/line_openchat` は同じService Token（Keychain `manage-asset:portal-sync`）で `POST /api/openchat/sync` と `GET /api/openchat/ledger` を呼びます。Access Applicationの保護対象は `dashboard.hiraku00.workers.dev` のホスト全体（パス指定なし）で、Service Authポリシー「manage-asset portal sync」がアプリ全体に付いているため、`/api/openchat/*` にも追加の設定は不要です（2026-09-24にダッシュボードで確認）。今後、保護対象をパス単位に絞る場合は、`/api/openchat/*` を `/api/manage-asset/sync` と同じService Authの対象に含めてください。

本番D1には `migrations/0009_openchat.sql` を `wrangler d1 execute DB --remote --file=...` で直接適用済みです（2026-09-24）。`migrations apply` は使いません: 本番はこれまで `ensureSchema()` で表を作ってきたため、0004〜0008も未適用と記録されており、全部を流し直してしまいます。0009は `CREATE ... IF NOT EXISTS` だけなので、デプロイ後に `ensureSchema()`（schema version 5）が同じ内容を流しても安全です。

`migrations/0010_openchat_note_meta.sql`（人が編集する放送局・放送タイトル・リンクの表 `openchat_note_meta`、schema version 6）は**まだ本番へ適用していません**。デプロイ前に、0009と同じ方法（`wrangler d1 execute DB --remote --file=migrations/0010_openchat_note_meta.sql`）で適用します。`CREATE TABLE IF NOT EXISTS` だけなので、`ensureSchema()` が先に表を作っていても安全です。

## R2

`wrangler.jsonc` の `FILES` bindingが `hiraku-portal-files` を指します。本文・原本の書き込み後、D1のrevision/台帳との対応を確認します。R2の利用量は日次reconciliationで確認し、上限に近づいた場合は新規原本の保持期間や不要オブジェクトを見直します。

## ロールバック

Workerの表示/API不具合は直前のWorker versionへ戻します。D1 migrationは自動逆戻しせず、必要なら逆migrationまたはバックアップからの復旧を計画します。R2オブジェクトは削除前に参照元とバックアップを確認します。
