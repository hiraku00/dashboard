# Manage Asset local collector

このディレクトリは、旧 `/Users/hiraku/Practice/manage-asset` から移植したMac専用の取得処理です。

- `app.py`: JSONL保存、Keychain参照、スナップショット正規化
- `debank_auto.py`: DeBankウォレット取得
- `exchange.py`: 取引所コネクタ
- `scripts/daily_update.py`: launchdから呼ぶ取得オーケストレーター
- `scripts/sync_to_portal.py`: ローカルJSONLをCloudflare D1/R2へ送信
- `config/app-config.json`: 実行時間

APIキー・API Secret・Passphraseはプロジェクト内に保存しません。既存のKeychainサービス（`manage-asset/<source_id>`）を使用します。Portal同期用Service Tokenも `manage-asset:portal-sync` から取得します。

## 初回セットアップ

```bash
python3 -m pip install -r collector/requirements.txt
python3 -m playwright install chromium
```

`collector/data/` は個人データのためGit管理対象外です。移行時は旧collectorから `wallets.json`、`sources.json`、既存JSONLをコピーします。

## 手動検証

```bash
PORTAL_URL=https://hiraku-watch-list.hiraku-watch-list.workers.dev \
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
