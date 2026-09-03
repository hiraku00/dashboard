# Manage Asset local collector

このディレクトリは、Manage AssetのMac専用取得処理です。取得はローカルで行い、認証情報をCloudflare Workerへ渡さず、完了したスナップショットだけをポータルへ同期します。

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

`collector/data/` は個人データのためGit管理対象外です。既存のローカルデータを移行する場合は、実行環境のデータディレクトリから `wallets.json`、`sources.json`、既存JSONLをコピーします。

Playwrightの実ブラウザ本体（Chromium）は`~/Library/Caches/ms-playwright/`に保存されます。pipパッケージ本体とは別物のため、macOSのディスク容量整理やキャッシュ削除ツールで消えることがあります。`debank_auto.py`はブラウザ起動時にこの状態を検知すると`playwright install chromium`を自動実行して復旧するため、手動対応は不要です。

`daily_update.py`は`config/app-config.json`の`windows`/`additional_retry_times`で定義された各スロット（例: 06:30〜07:50を10分おき）ごとに起動されますが、Portal同期は「新規に取得したデータがある」か「前回の同期がまだ成功していない（`portal_sync_pending`）」場合のみ実行します。取得済みのデータをスロットのたびに再送信することはありません。

## 手動検証

```bash
PORTAL_URL=https://dashboard.hiraku00.workers.dev \
PORTAL_SYNC_CLIENT_ID='…' \
python3 collector/scripts/daily_update.py
```

時間帯外での検証だけは、明示的な `MANAGE_ASSET_FORCE_RUN=1` を付けて実行できます。launchdにはこのフラグを設定しません。

実行時間外に手動検証する場合は、一時的に `collector/config/app-config.json` の時間帯を変更するか、collectorの関数テストを使用してください。取得処理はMac上でのみ実行し、Cloudflare Worker内ではAPIキーを扱いません。

## launchd登録

```bash
bash collector/scripts/install_launchd.sh
```

スクリプトがリポジトリの現在位置を基準にplistを生成し、`~/Library/LaunchAgents/`へ登録します。登録後は、`launchctl print gui/$(id -u)/com.watch-list.manage-asset-collector` で実行パスを確認します。

## 同期後の確認

1. collectorの終了コードが0であることを確認する。
2. source別の取得成功・失敗件数を確認する。
3. `/manage-asset/sync` で当日の日付と最終同期時刻を確認する。
4. `/manage-asset` の総資産、stETH、資産配分を確認する。
5. `/manage-asset/currencies` と `/manage-asset/locations` の合計がホームと整合することを確認する。

Service AuthやKeychainが失敗した場合は、APIキーの値をログに出力せず、サービス名、戻り値、実行時刻だけを調査材料にします。同じsourceに対するcollectorの二重実行は設定しないでください。
