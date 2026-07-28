# Manage Asset運用

## 画面

Manage Assetは既存アプリの表示仕様を基準にした資産ダッシュボードです。

- ホーム: 総資産、資産推移、資産配分、保有資産
- 保管場所: Lido、取引所、DeFiなどの保管場所別内訳
- 通貨推移: stETH、BTC、USDT、ETH、BNBなどの通貨別履歴
- データ更新: 取得元ごとの成功日時、同期状態、古いデータの警告
- 設定: 表示や同期に関する設定

元のUI資産は `public/manage-asset-original/` に保持し、ポータル側はこれを基準に共通ヘッダーとCloudflare側のデータ連携を提供します。表示上の文言、桁数、表の列、グラフの期間、ホバー表示を変更する場合は、元UIとの互換性を確認します。

## データ取得の責務

外部APIを使う取得処理はMacのcollectorが担当します。Workerは外部APIキーを持たず、受信したスナップショットの検証・保存・表示だけを行います。

```text
launchd
  → collector/app.py
  → Keychainから source ごとのAPIキーを取得
  → 各API / CSV / ローカルソースを取得
  → 日次スナップショットを生成
  → /api/manage-asset/sync へService Authで送信
  → asset_sync_runs / asset_snapshots / asset_positionsへ保存
```

## Keychain

APIキーは次の命名規則でmacOS Keychainに保存します。

- 外部取得用: `manage-asset/<source_id>`
- ポータル同期用Service Token: `manage-asset:portal-sync`

実際の値をログ、コミット、チャット、Cloudflareの環境変数へコピーしません。collectorはKeychainから読み出せない場合、取得を成功扱いにせず、どのsourceが失敗したかをログに残します。

## 日次データの意味

- stETH: Lidoの報酬データを利用できる期間では報酬として表示し、未取得期間は残高差から暫定計算する。
- それ以外の資産: 入出金、報酬、価格変動を区別せず、前回記録日からの残高差を「変化」として扱う。
- 日次増加量: 表示期間内の各日の残高差を基準にする。単日の新規取得を期間全体の増加として加算しない。
- 取得不能日: 欠損をゼロとして補間せず、前回成功データと欠損状態を分けて表示する。

計算ロジックを変更する場合は、`collector`の生成値、D1保存値、UIの表示値を同じ日付・同じ通貨で突合します。

## 同期確認

1. Macでcollectorの終了コードを確認する。
2. `asset_sync_runs`で対象日の成功件数と失敗件数を確認する。
3. `/manage-asset/sync`で各sourceの最終取得日を確認する。
4. `/manage-asset`で総資産、stETHを含む配分、通貨推移を確認する。
5. 同一日付を再同期した場合に重複行が増えていないことを確認する。

## よくある原因

### 本日分が表示されない

- launchdが旧collectorを実行している
- `PORTAL_URL` またはService AuthのKeychain値が未設定
- 取得は成功したが同期APIが失敗している
- source単位で取得日時が異なり、前回成功値が表示されている
- D1 migration後にWorkerが古いバージョンのまま

### 全通貨の当日増加量が大きい

当日スナップショットを前日と比較できず、初回値や欠損を差分として扱っている可能性があります。日付キー、sourceキー、前回有効スナップショットの選択を確認し、取得元の数量とUIの差分を突合します。

## 関連ファイル

- `public/manage-asset-original/`: 既存UIの基準アセット
- `app/manage-asset-app.tsx`: ポータル組み込み
- `app/api/manage-asset/`: 表示・同期API
- `collector/`: ローカル取得処理
- `scripts/sync-manage-asset.mjs`: 手動同期
