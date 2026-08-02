# データモデルと保存先

## D1

### Watch List

- `items`: 項目本体、ステータス、優先度、出典、削除日時
- `item_links`: 項目に紐づくリンク
- `import_runs`: インポート単位の件数・エラー履歴

### TextTube

- `text_tube_videos`: 一覧・検索用の動画/音声/記事メタデータ
- `text_tube_video_revisions`: 詳細本文の版管理とR2オブジェクト参照
- `text_tube_api_usage`: 字幕APIの実消費クレジット、HTTP状態、取得日時

### Manage Asset

- `asset_sources`: 取得元・保管場所などのソース定義
- `asset_sync_runs`: 取得・同期の実行履歴
- `asset_snapshots`: 日付ごとの集計スナップショット
- `asset_positions`: スナップショット内の通貨・保管場所別ポジション

### Storage

- `storage_objects`: R2オブジェクトの論理台帳
- `storage_usage_daily`: 日次使用量とカテゴリ別集計

正確な列定義は `db/schema.ts` と `drizzle/0001_portal.sql` を正とします。スキーマ変更時はDrizzle migrationを追加し、既存データを壊す変更はバックアップとロールバック手順を先に用意します。

## R2

R2は大量本文や原本など、一覧検索よりもオブジェクト保存に向くデータを格納します。D1には本文全体を重複して保存せず、オブジェクトキー、版、サイズ、ハッシュなどのメタデータを保持します。

主な用途:

- TextTubeの詳細Markdownと改訂版
- インポート原本・移行用ファイル
- 将来追加するポータル内ファイル

## データの正しさ

- Manage Assetの表示は最新の有効なスナップショットを基準にする。
- 同一ソース・同一日付の再同期は冪等に扱い、重複行を作らない。
- 取得できなかったソースは成功済みの前回スナップショットと区別して表示する。
- stETHを含む各通貨の履歴は、取得元の残高と報酬/変化の意味を保持する。
