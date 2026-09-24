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

## ちきりんオプチャ（LINE）

`line_openchat/` は、Mac版LINEのオープンチャット「集まれテレビっ子」のノートを画面から読み取り、ちきりんさんのスレッド・コメントをPortalへ同期します。**LINEは参照のみ**で、投稿・リアクション・削除などは行いません（`safety.py`と`tests/test_safety.py`が機械的に禁止・確認しています）。設計・前提・注意点は [docs/chikirin-openchat.md](../docs/chikirin-openchat.md)。

```bash
cd collector
python3 -m pip install -r line_openchat/requirements.txt   # 初回のみ
python3 -m line_openchat.sync --dry-run            # Portalへ送らず、台帳(data/line_openchat/ledger.json)だけ更新
PORTAL_URL=https://dashboard.hiraku00.workers.dev PORTAL_SYNC_CLIENT_ID='…' python3 -m line_openchat.sync
python3 -m line_openchat.sync --first-run          # 一覧の最後まで全件を読み直す
python3 -m pytest tests                            # collectorのテスト
```

実行中はマウスでLINEを操作するので、数分間Macを触らないでください。マウスやキーボードを操作すると、その場で中断します（次回はその続きから始まります）。LINEでオープンチャットを開き、ノートウィンドウを表示してから実行します。

## 初回セットアップ

```bash
python3 -m pip install -r collector/requirements.txt
python3 -m playwright install chromium
```

`collector/data/` は個人データのためGit管理対象外です。既存のローカルデータを移行する場合は、実行環境のデータディレクトリから `wallets.json`、`sources.json`、既存JSONLをコピーします。

Playwrightの実ブラウザ本体（Chromium）は`~/Library/Caches/ms-playwright/`に保存されます。pipパッケージ本体とは別物のため、macOSのディスク容量整理やキャッシュ削除ツールで消えることがあります。`debank_auto.py`はブラウザ起動時にこの状態を検知すると`playwright install chromium`を自動実行して復旧するため、手動対応は不要です。

`daily_update.py`は`config/app-config.json`の`windows`/`additional_retry_times`で定義された各スロット（後述、UTC基準で00:00〜01:00を10分おき＋追加リトライ02:05）ごとに起動されますが、Portal同期は「新規に取得したデータがある」か「前回の同期がまだ成功していない（`portal_sync_pending`）」場合のみ実行します。取得済みのデータをスロットのたびに再送信することはありません。

### 実行スケジュールの根拠

`config/app-config.json`の`daily_update`は`timezone: "UTC"`で、スロットはすべてUTC基準の時刻。現地時刻に直すと:

| UTC | 日本時間(JST, UTC+9) | バンコク時間(UTC+7) |
|---|---|---|
| 00:00〜01:00（10分おき） | 09:00〜10:00 | 07:00〜08:00 |
| 02:05〜02:30（5分おき） | 11:05〜11:30 | 09:05〜09:30 |

- **`timezone: "UTC"`・窓を00:00始まりにした理由**: D1の無料枠カウンタはUTC 00:00にリセットされ、使用量ページの「本日」もUTC日で計上される。以前はMacのローカル時刻（`06:30`など）で判定していたため、Macの所在地（バンコク/日本）によって同じ実行がUTCの前日・当日どちらに計上されるか変わってしまっていた（#50）。UTC 00:00起点に固定することで、Macがどこにあっても同じUTC日に計上される。
- **窓の終わりを`01:00`にした理由**: 単にD1カウンタのリセット直後から1時間、10分おきに取得を試みるのに十分な長さとして選んだ（以前は`01:20`だったが、これは旧スケジュール（バンコク時間`06:30〜07:50`）をUTCへ機械的にシフトした際の副産物で、`07:50`という半端な終了時刻自体に他の意図はなかった）。
- **2つ目の窓を`02:05〜02:30`（日本時間11:05〜11:30、5分おき）にした理由**: GMOコインは毎週土曜9:00〜11:00（日本時間）に定例システムメンテナンスがある
  （https://support.coin.z.com/hc/ja/articles/115007815487）。通常の窓（日本時間09:00〜10:00）はメンテ時間内にすべて収まってしまうため、この間の取得は必ず失敗する。当初はメンテ終了（11:00 JST）の5分後、単発の`02:05`だけをリトライに設定していたが、実際にその時刻でもまだ復旧しておらず失敗した（2026-09-12に確認）。メンテ終了の告知時刻ちょうどにAPIが復旧するとは限らないため、単発の1回ではなく`02:30`（11:30 JST）まで5分おきに複数回リトライする窓に変更した。GMO以外の一時的な取得失敗も、この窓でまとめてリトライされる。

`sync_to_portal.py`は`start` → `sources`（最大25件ずつのバッチ、`BATCH_SIZE`）→ `complete`の順にPortalへ送信します。Portal側はR2使用量の集計（`storage_objects`テーブル全体の集計）をリクエストごとに1回だけ行うため、ソース1件ずつ送るとこの集計がソース数分繰り返されます。バッチ送信により、17ソースで約9万行あったD1読み取りが約5千行に減ります。Portal側は旧形式の`source`（1件ずつ）も引き続き受け付けるため、collectorとWorkerのバージョンが一時的にずれても同期は継続します。

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
