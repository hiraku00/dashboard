# 日次運用・障害対応

## 日次フロー

1. launchdがMac collectorを起動する。
2. collectorがKeychainからAPIキーを読み出す。
3. 各sourceを取得し、日付付きスナップショットを生成する。
4. Workerの同期APIへ送信する。
5. D1の同期履歴・スナップショット・ポジションを更新する。
6. ブラウザでManage Assetとストレージ状態を確認する。

取得元ごとの成功時刻が異なるため、全sourceが同じ時刻に揃わないことがあります。画面の「古いデータ」警告は、当日成功していないsourceを隠さず示すためのものです。

## ローカル確認

```bash
cd <dashboard-repository>
python3 collector/scripts/daily_update.py
python3 collector/scripts/sync_to_portal.py
```

`<dashboard-repository>` は実際にcloneしたローカルディレクトリへ置き換えます。個人ユーザー名を含む絶対パスはリポジトリへ記録しません。

通常運用ではlaunchdを使用します。手動実行時もAPIキーをコマンド履歴やログへ出力しないでください。collectorの詳細は `collector/README.md` を参照します。

## 同期が反映されない場合

確認順序:

1. launchdが現在の `dashboard/collector` を実行しているか
2. collectorのexit codeとsource別エラー
3. `PORTAL_URL` がworkers.devの本番URLか
4. Access Service Authのclient ID/secretがKeychainにあるか
5. `asset_sync_runs` の成功/失敗件数
6. 対象日・source・currencyのキーが一致しているか
7. WorkerのversionとD1 migrationが最新か

Portal同期はDNS解決や接続タイムアウトなどの一時的なネットワーク障害に対して、最大4回（指数バックオフ）再試行します。それでも失敗した場合は `daily_update.py` が終了コード1を返すため、launchdの実行結果を失敗として扱えます。再試行後も反映されない場合は、まず `asset_sync_runs` の失敗内容を確認し、必要に応じて最新スナップショットを `sync_to_portal.py` で手動同期します。

当日データがD1に入っていて画面だけ古い場合は、キャッシュではなくAPIレスポンスの日付と選択中の期間・通貨を確認します。

## 異常な日次増加量

当日値が前日値と比較されているか、欠損日を誤ってゼロとして扱っていないかを確認します。初回スナップショット、sourceの入れ替え、通貨シンボルの正規化差異が典型的な原因です。取得元数量、D1保存値、UI計算結果を同じ日付で並べて検証します。

## ストレージ

`/settings/storage` でD1/R2使用量とカテゴリを確認します。R2オブジェクトを手動削除した場合は `storage_objects` と実体の不一致が起きるため、reconciliationを実行してから台帳を修正します。

## バックアップと復元

D1（`hiraku-watch-list`）には Cloudflare 側の Time Travel（過去の時点への復元）がありますが、復元できる期間は限られます。手元にも SQL ファイルとして保存しておきます。

```bash
npm run backup:d1                      # ~/Backups/dashboard/ に dashboard-d1-<日時>.sql を保存
node scripts/backup-d1.mjs <出力先>     # 出力先を変える（リポジトリの中は指定できない）
```

- 読み取りだけです。全テーブルを1回読みます（いまは合計3万行ほど、約15MB）。繰り返し呼ばず、週に1回ほどにします。
- 書き出している間（数秒）、D1 は応答しません（wrangler の確認メッセージにも出ます）。朝の同期や、アプリを使っている最中は避けます。
- `--keep 8` を付けると、保存に成功したあと、このスクリプトが作った古いファイルを新しい8件だけ残して消します。
- 保存したファイルは個人データそのものです。リポジトリの外に置き、古いものは手で整理します。
- R2（TextTube の詳細スクリプト、資産同期の原本）は含みません。
- ウォレット2（`hiraku-manage-asset-wallet2`）は本番から作り直せるので、対象にしていません。

復元は、まず手元で中身を確かめてから行います。

```bash
# 1. 空のローカル D1 に入れて、件数を確かめる（本番には触らない）
npx wrangler d1 execute hiraku-watch-list --local --persist-to /tmp/restore-check --file <保存したファイル>
npx wrangler d1 execute hiraku-watch-list --local --persist-to /tmp/restore-check --command "SELECT COUNT(*) FROM items"

# 2. 直近の誤操作なら、Time Travel で時点を指定して戻すほうが早い
npx wrangler d1 time-travel info hiraku-watch-list
npx wrangler d1 time-travel restore hiraku-watch-list --timestamp <ISO日時>
```

本番へ SQL ファイルを流し込む復元（`--remote --file`）は、既存の行と衝突するので、空の D1 に対してだけ行います。

### 週次の自動実行（launchd）

Mac の launchd に、毎週日曜 03:17（Mac の時刻。眠っていれば起きたあと）に `backup-d1.mjs --keep 8` を実行する登録があります。

```bash
sh scripts/install-backup-launchd.sh              # 登録する（リポジトリや node の場所を変えたら、もう一度）
sh scripts/install-backup-launchd.sh --uninstall  # 登録を外す
launchctl kickstart gui/$(id -u)/com.watch-list.d1-backup   # すぐに1回実行する
tail ~/Library/Logs/dashboard-d1-backup.log                # 結果（成功なら「保存しました」）
```

- 認証は、`wrangler login` で保存された Cloudflare のログインを使います。ログインが切れると、ログに失敗が残ります。
- 置き場は `~/Backups/dashboard/`（新しい8件）、ログは `~/Library/Logs/dashboard-d1-backup.log` です。
