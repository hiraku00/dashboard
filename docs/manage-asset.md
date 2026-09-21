# Manage Asset運用

## 画面

Manage Assetは既存アプリの表示仕様を基準にした資産ダッシュボードです。

- ホーム: 総資産、資産推移、資産配分、保有資産
- 保管場所: Lido、取引所、DeFiなどの保管場所別内訳
- 通貨推移: stETH、BTC、USDT、ETH、BNBなどの通貨別履歴
- データ更新: 取得元ごとの成功日時、同期状態、古いデータの警告
- 設定: 表示や同期に関する設定

各画面は他のポータル機能と同じくServer Componentとして実装されたネイティブなReact実装です（`app/manage-asset-overview.tsx`・`manage-asset-locations.tsx`・`manage-asset-currency.tsx`・`manage-asset-settings.tsx`・`manage-asset-sync-view.tsx`）。計算ロジックは`app/lib/manage-asset-core.ts`の純関数に集約されており、表示上の文言、桁数、表の列、グラフの期間、ホバー表示を変更する場合は`tests/manage-asset-core.test.mjs`で数値の同値性を確認します。設定・データ更新は読み取り専用です（取引所の追加、認証情報の変更、ウォレットの編集はMac側collectorが担当し、このポータルには対応する書き込みAPIがありません）。

### 初期データの読み込み

各ページの初期データは、最初に開く資産概要が使う分だけです（stateと「合計のみ」の履歴、最終同期。本番で約160KB）。通貨推移が使うデータ（トークン・ポジションを含む履歴、Lidoの報酬、為替レート。合わせて約1MB）は、通貨推移のタブを初めて開いたときに取得し、以後は保持します。通貨推移を最初に開くルート（`/manage-asset/currencies`）だけは、待たせないよう、これらを最初から返します。

stETHの履歴は、LidoのCSVを移行境界日（2026-07-12）以降のスナップショットで継ぎ足して作るため、履歴の期間がその日に届かないときは、全期間を取得します（届かないまま描くと、欠けた日数分の増加量が1日分の報酬として出ます）。

### モバイル幅での表示

- グラフ（`app/manage-asset-overview.tsx`・`manage-asset-currency.tsx`）は、軸ラベルを画面上で常に約11pxに保つため、幅が狭いほどSVGのuser-space上ではラベルが大きくなります。`app/manage-asset-chart-tooltip.tsx`の`axisLayout()`が、表示倍率が0.85未満のときだけ、y軸の左余白・ラベルとの隙間（約8px）・縦方向の寸法を画面px基準で広げます。0.85以上（PC相当）は従来の固定値のままです。軸ラベルや余白を変更する場合は、PC幅で描画が変わらないことと、375px幅でラベルがカード内に収まることの両方を確認します。
- 表は`.table-scroll`で横スクロールします。監視リストの`content-table`用にモバイル幅（760px以下）で`.table-scroll`をカード表示へ切り替えるルールがあるため、資産管理側は`.asset-workspace .table-scroll`でスクロールを戻し、先頭列（資産名・日付・保管場所名）を固定しています。

## 総資産の定義（ホームとManage Assetで共通）

ホームの資産合計と、Manage Assetの「総資産」は、同じ定義で計算します（`app/lib/portal-summary.ts`が、Manage Assetと同じ`total()` / `latestFx()`を使います）。

- USD: 各保管場所の最新スナップショットが保存している合計（`total_usd`）の和。保存された合計が0のスナップショットは0として数えます（ポジション明細の合計で代用しません）。小さなウォレットは、DeBankの整数丸めで合計が`$0`と保存されることがあり、明細と数セントずれますが、これは仕様です。
- JPY: 上のUSD合計に、最新のスナップショットが持つ1つのUSD/JPYレート（`fx_usdjpy`）を掛けた値。どのスナップショットにもレートがないときだけ、保存されたJPYの和を使います。

## データ取得の責務

外部APIを使う取得処理はMacのcollectorが担当します。Workerは外部APIキーを持たず、受信したスナップショットの検証・保存・表示だけを行います。

USD/JPYは、個人利用向けに一般的に使われているYahoo Financeの公開チャートエンドポイント（`USDJPY=X`）から取得します。無料で利用できますが、公式の安定APIではなく、相場データに遅延が含まれる場合や、将来仕様変更・レート制限が発生する可能性があります。売買執行や投資判断の基準値には使用しません。

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

- launchdが登録済みのcollectorを実行していない
- `PORTAL_URL` またはService AuthのKeychain値が未設定
- 取得は成功したが同期APIが失敗している
- source単位で取得日時が異なり、前回成功値が表示されている
- D1 migration後にWorkerが古いバージョンのまま

### 「総額と明細に差があります」と表示される

資産概要は、保管場所ごとに「スナップショットが申告した総額」と「ポジション明細の合計」を突き合わせ、差が1 USDを超えた保管場所を警告します（`reconciliation()`、許容値は`RECONCILIATION_TOLERANCE_USD`）。

ウォレットの総額はDeBankのヘッダー表示をそのまま読み取るため、残高が数ドル以下だと整数に丸められます（例: 明細合計0.49に対し総額`$1`）。整数丸めの誤差は最大0.5 USDなので、1 USD以内の差は丸めとして扱い、警告しません。1 USDを超える場合は、明細の取りこぼし（未評価のトークン、取得失敗した保管場所）を疑い、該当sourceの最新スナップショットとポジションを確認します。

### 全通貨の当日増加量が大きい

当日スナップショットを前日と比較できず、初回値や欠損を差分として扱っている可能性があります。日付キー、sourceキー、前回有効スナップショットの選択を確認し、取得元の数量とUIの差分を突合します。

## 関連ファイル

- `app/manage-asset-app.tsx`: ビュー切り替えとタブ間で共有する`state`/`history`の管理
- `app/manage-asset-overview.tsx` / `manage-asset-locations.tsx` / `manage-asset-currency.tsx` / `manage-asset-settings.tsx` / `manage-asset-sync-view.tsx`: 各画面の実装
- `app/lib/manage-asset-core.ts`: 計算ロジック（純関数、テスト済み）
- `app/lib/queries/manage-asset.ts`: D1読み取りの共有ロジック（ページとAPIの両方が呼ぶ）
- `app/api/manage-asset/`: 表示・同期API
- `collector/`: ローカル取得処理
- `scripts/sync-manage-asset.mjs`: 手動同期
