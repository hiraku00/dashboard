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
cd /Users/hiraku/Practice/watch-list
python3 collector/scripts/daily_update.py
python3 collector/scripts/sync_to_portal.py
```

通常運用ではlaunchdを使用します。手動実行時もAPIキーをコマンド履歴やログへ出力しないでください。collectorの詳細は `collector/README.md` を参照します。

## 同期が反映されない場合

確認順序:

1. launchdが現在の `watch-list/collector` を実行しているか
2. collectorのexit codeとsource別エラー
3. `PORTAL_URL` がworkers.devの本番URLか
4. Access Service Authのclient ID/secretがKeychainにあるか
5. `asset_sync_runs` の成功/失敗件数
6. 対象日・source・currencyのキーが一致しているか
7. WorkerのversionとD1 migrationが最新か

当日データがD1に入っていて画面だけ古い場合は、キャッシュではなくAPIレスポンスの日付と選択中の期間・通貨を確認します。

## 異常な日次増加量

当日値が前日値と比較されているか、欠損日を誤ってゼロとして扱っていないかを確認します。初回スナップショット、sourceの入れ替え、通貨シンボルの正規化差異が典型的な原因です。取得元数量、D1保存値、UI計算結果を同じ日付で並べて検証します。

## ストレージ

`/settings/storage` でD1/R2使用量とカテゴリを確認します。R2オブジェクトを手動削除した場合は `storage_objects` と実体の不一致が起きるため、reconciliationを実行してから台帳を修正します。
