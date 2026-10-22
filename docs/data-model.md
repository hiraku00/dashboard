# データモデルと保存先

## D1

### Watch List

- `items`: 項目本体、ステータス、優先度、出典、削除日時、サムネイル画像のURL（`thumbnail_url`）
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

### To Do

- `todo_boards`: 看板の名前とタイムゾーン
- `todo_columns`: 受信箱・今日・進行中・完了の列と表示順
- `todo_routines`: 毎日または曜日指定で生成する繰り返しタスクのテンプレート
- `todo_tasks`: 単発タスクと、繰り返しタスクから日付ごとに生成された実行カード
- `todo_task_events`: カードの移動履歴

### ちきりんオプチャ

- `openchat_notes`: LINEオープンチャットのノート（1ノート＝1番組）。投稿者、本文、投稿日時とその精度（`exact` / `approx_min` / `approx_hour`）、コメント数、ちきりんのコメント数（`target_comment_count`）、再確認が必要か（`needs_recheck`）
- `openchat_note_meta`: 人が画面から編集する、放送局・その日の放送タイトル・リンク（`links_json`）。collector の同期データ（`openchat_notes`）とは別のテーブルなので、同期で上書きされない。`migrations/0010_openchat_note_meta.sql`、schema version 6。
- `openchat_note_thumbnails`: 一覧のサムネイル。`source_url`は画像を探したリンク、`thumbnail_url`は見つからなければ空（「試した」の記録を兼ねる）。同期時と放送情報の保存時に書く。`migrations/0013_openchat_note_thumbnails.sql`、schema version 9。
- `openchat_comments`: ノートのコメント。`is_target`がちきりん（公式バッジで判定）。`deleted_at`は、LINE上で見えなくなったとcollectorが判断した時刻（件数が一致したときだけ付く）
- `openchat_sync_runs`: collectorの同期履歴（状態、走査・展開したノート数、新しいコメント数、警告）

ちきりん以外の投稿も保存するのは、collectorが「取得済みか」を判定する台帳を失ったときに復元できるようにするため。画面とAPIの一覧には出さない。

### 作業日報

auto-daily-report が生成する1日1件の作業日報（`migrations/0017_daily_reports.sql`、schema version 13）。設計は[作業日報の取り込み設計](daily-report-ingest-design.md)。どのテーブルも `report_date`（`YYYY-MM-DD`）で引く。

- `daily_reports`: 1日1行。原本のMarkdown（`markdown`、R2は使わない）と `sha256`、見出しから読んだ記録期間・キャプチャ回数（「N回以上」は `capture_count_is_min=1`）、「ログなし」の合計分（`gap_minutes`）、解析の版（`parser_version`）と結果（`parse_status`: `ok`/`partial`/`failed`、`parse_warnings`: 警告のJSON配列）。`failed` でも行と原本は残す
- `daily_report_revisions`: 内容が変わった再送のときに、差し替えられる前の原本を退避する。集計には使わない
- `daily_report_work_items` / `daily_report_app_usage` / `daily_report_time_blocks` / `daily_report_notes`: 「本日のメイン作業」「アプリ使用状況」（`app_key` は集計用に寄せたアプリ名）「作業詳細」（0時からの分。日付をまたげば1440を超える）「得られた知見・メモ」の正規化
- `daily_report_item_tags`: 作業項目（`source='work'`）・時間帯（`source='time'`）に付いたタグ
- `daily_report_tag_days`: 1日×タグの合計（分・作業項目数）。どのタグにも当たらない分は `other`。週・月の集計はこの表の `SUM` だけで済ませる

正規化とタグのテーブルは、取り込み・再解析のたびにその日付の分を作り直す（`app/lib/daily-report-store.ts`）。解析とタグ付けの規則は `app/lib/daily-report-parse.ts` と `app/lib/daily-report-tags.ts`。

- `daily_report_summaries`: auto-daily-report の `summarize.py` が作る週次・月次サマリ（`migrations/0018_daily_report_summaries.sql`、schema version 14）。主キーは (`kind`, `period_start`)。`kind` は `week`（月曜〜日曜）か `month`（1日〜末日）、`period_start` / `period_end` は `YYYY-MM-DD`。原本のMarkdown（`markdown`）と `sha256` だけを置き、解析・タグ付けはしない。書き直しは上書きで、改訂は残さない（`app/lib/daily-report-summary-store.ts`）

### Storage

- `storage_objects`: R2オブジェクトの論理台帳
- `storage_usage_daily`: 日次使用量とカテゴリ別集計
- `d1_table_usage_daily`: D1のテーブルごとの行数と容量の概算（値の長さの合計。索引・ページの余白は含まない）を1日1回記録。D1は `dbstat` を使えないため（2026-10-23に本番で確認）この概算にしている。日次のcron（UTC 02:17）と `POST /api/cron/reconcile-storage` で計測し、使用量画面は記録を読むだけ（`app/lib/d1-table-usage.ts`）

正確な列定義は `db/index.ts` の `ensureSchema()` を正とします（新規DB向けのCREATE文一式）。既存DBへ適用済みの変更は `migrations/` のSQLに残っています。スキーマ変更時は `migrations/` に連番のSQLを追加し（`wrangler d1 migrations apply` で適用）、同じ変更を `ensureSchema()` にも反映します。既存データを壊す変更はバックアップとロールバック手順を先に用意します。

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
