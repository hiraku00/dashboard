# Manage Asset local collector

このディレクトリは、旧 `/Users/hiraku/Practice/manage-asset` から移植したMac専用の取得処理です。

Personal Portal全体の構成は、リポジトリ直下の [README](../README.md)、データ取得と表示の責務は [Manage Asset運用](../docs/manage-asset.md) を参照してください。

- `app.py`: JSONL保存、Keychain参照、スナップショット正規化
- `debank_auto.py`: DeBankウォレット取得
- `exchange.py`: 取引所コネクタ
- `scripts/daily_update.py`: launchdから呼ぶ取得オーケストレーター
- `scripts/sync_to_portal.py`: ローカルJSONLをCloudflare D1/R2へ送信
- `config/app-config.json`: 実行時間

USD/JPYの評価レートは、Yahoo Financeの`USDJPY=X`公開チャートを利用します。`query2.finance.yahoo.com`を優先し、取得できない場合は`query1.finance.yahoo.com`へフォールバックします。個人利用向けの無料データであり、公式の安定APIや売買用のリアルタイムレートではありません。

APIキー・API Secret・Passphraseはプロジェクト内に保存しません。既存のKeychainサービス（`manage-asset/<source_id>`）を使用します。Portal同期用Service Tokenも `manage-asset:portal-sync` から取得します。

## 初回セットアップ

```bash
python3 -m pip install -r collector/requirements.txt
python3 -m playwright install chromium
```

`collector/data/` は個人データのためGit管理対象外です。移行時は旧collectorから `wallets.json`、`sources.json`、既存JSONLをコピーします。

## 手動検証

```bash
PORTAL_URL=https://dashboard.hiraku00.workers.dev \
PORTAL_SYNC_CLIENT_ID='…' \
python3 collector/scripts/daily_update.py
```

時間帯外での検証だけは、明示的な `MANAGE_ASSET_FORCE_RUN=1` を付けて実行できます。launchdにはこのフラグを設定しません。

実行時間外に手動検証する場合は、一時的に `collector/config/app-config.json` の時間帯を変更するか、collectorの関数テストを使用してください。取得処理はMac上でのみ実行し、Cloudflare Worker内ではAPIキーを扱いません。

## launchd切替

```bash
cp collector/launchd/com.watch-list.manage-asset-collector.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.watch-list.manage-asset-collector.plist
```

新collectorの手動実行・Cloudflare同期・launchd実行を確認した後、旧 `com.manage-asset.daily-update` を停止します。旧プロジェクトの削除は、数回の定期実行を確認してから行います。

## 同期後の確認

1. collectorの終了コードが0であることを確認する。
2. source別の取得成功・失敗件数を確認する。
3. `/manage-asset/sync` で当日の日付と最終同期時刻を確認する。
4. `/manage-asset` の総資産、stETH、資産配分を確認する。
5. `/manage-asset/currencies` と `/manage-asset/locations` の合計がホームと整合することを確認する。

Service AuthやKeychainが失敗した場合は、APIキーの値をログに出力せず、サービス名、戻り値、実行時刻だけを調査材料にします。旧collectorと新collectorを同じsourceに対して同時実行しないでください。
