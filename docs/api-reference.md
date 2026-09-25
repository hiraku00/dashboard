# API一覧

すべてのAPIはWorker配下の認証済みルートです。本番ではCloudflare Accessを経由し、ブラウザの通常操作とcollectorのService Authを区別します。正確な入力スキーマは各route実装を正とします。

## Watch List

| パス                                   | 用途                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/items`                       | 検索（`q`はタイトル・内容・人物・番組名・リンクのURL/表示名に部分一致。48バイトを超える検索語はD1のLIKE制限を避けるため切り詰める）、絞り込み、ページング付き一覧。各項目に`thumbnailUrl`（サムネイル画像のURL、なければ空文字）を含む。                         |
| `POST /api/items`                      | 項目作成。レスポンスの`textTubeCandidates`に、リンク中のYouTube動画ID（重複除く）を返す。画面がこれを1件ずつ`POST /api/text-tube/imports/run`へ渡してTextTubeへ自動登録する。各項目のYouTubeリンクには`textTube`（`reflected`/`running`/`failed`/`none`）が付く。 |
| `POST /api/watch-list/youtube-preview` | 公開YouTube動画URLから、チャンネル名・タイトル・正規化リンクを取得して入力用データを返す。返す項目は`seriesTitle`・`title`・`links`のみ。動画ページを読み取り、YouTubeにbot判定されて取れない場合はoEmbedで補う。YouTube Data APIやAPIキーは使用しない。 |
| `GET /api/items/:id`                   | 項目詳細                                                                                                                          |
| `PATCH /api/items/:id`                 | 項目更新。`textTubeCandidates`は、この保存で**新しく追加された**YouTubeリンクの動画IDのみ。                                                                                                                          |
| `DELETE /api/items/:id`                | 論理削除                                                                                                                          |
| `GET /api/stats`                       | 一覧用集計                                                                                                                        |
| `POST /api/imports`                    | Watch Listデータのインポート（最大200件）。保存時にリンク先のサムネイルも取得する（先頭16件まで）。レスポンスの`thumbnails`に`looked` / `found` / `skipped`を返す。 |
| `GET /api/exports`                     | バックアップ用エクスポート                                                                                                        |

## TextTube

| パス                                      | 用途                                                                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/text-tube/videos`               | 検索（`q`はタイトル・チャンネル名に部分一致。48バイトを超える検索語は切り詰める）・一覧                                                                                                                     |
| `POST /api/text-tube/videos`              | コンテンツ作成                                                                                                                                              |
| `GET /api/text-tube/videos/:id`           | コンテンツ詳細                                                                                                                                              |
| `PATCH /api/text-tube/videos/:id`         | メタデータ更新                                                                                                                                              |
| `DELETE /api/text-tube/videos/:id`        | コンテンツ削除                                                                                                                                              |
| `POST /api/text-tube/videos/:id/document` | Markdown本文・revision保存                                                                                                                                  |
| `POST /api/text-tube/youtube-preview`     | YouTube Data API v3でメタデータ、Supadataで既存YouTube字幕を取得してTextTube入力用データを返す。`YOUTUBE_DATA_API_KEY` と `SUPADATA_API_KEY` Secretが必要。 |
| `POST /api/text-tube/imports/run`         | `{ youtubeVideoId, itemId? }`で1本をTextTubeへ登録（動画情報＋字幕、要約は空）。結果は`reflected`（既にある）/`running`（別で実行中）/`done`/`failed`。自動登録と手動の「TextTubeへ反映」の共通の窓口。 |
| `GET /api/text-tube/imports/attention`    | 対応が必要な登録（`failed`、または10分以上進んでいない`stuck`）の一覧。Watch List上部の帯が使う。                                                              |
| `POST /api/text-tube/imports/:id/dismiss` | 上記の帯から1件を閉じる。                                                                                                                                   |
| `GET /api/settings/storage`               | R2使用量に加え、TextTube字幕APIの実消費クレジット・取得試行・最終取得日時を返す。                                                                           |

## ちきりんオプチャ

| パス | 用途 |
| --- | --- |
| `POST /api/openchat/sync` | collectorの同期。`start` → `notes`（1リクエスト10ノート・60コメントまで。同じノートのコメントを複数リクエストに分けてよい）→ `complete`。ノート・コメントはcollectorが発行したidでupsertするので、再送しても結果は変わらない。壊れたノートは結果に`error`を付け、ほかのノートは保存する。Cloudflare AccessのService Tokenで保護する。 |
| `GET /api/openchat/programs` | 画面用の一覧。`q`（番組名・ちきりんの本文）、`kind=all\|thread\|comment`、`page`（1始まり。既定は1）、`limit`（最大50、既定20）。ちきりんのスレッド、またはちきりんのコメントがあるノートだけを新しい順に返す。ほかの人のコメント本文は返さない。 |
| `PUT /api/openchat/programs/:id` | 人が編集する情報の保存。`{ broadcaster, episodeTitle, links: [{ url, label }] }`（放送局40字・放送タイトル200字・リンク5件まで、URLは http/https のみ。不正なら400で理由を返す）。collector の同期データとは別のテーブルに保存し、同期で上書きされない。一覧に載らないノートは404。 |
| `GET /api/openchat/programs/:id` | 詳細。1番組のスレッド主の投稿（`noteBody`）とちきりんのコメント全部を `{ program }` で返す。一覧に載らない（ちきりんが関わらない）・削除済み・存在しないノートは404。 |
| `GET /api/openchat/ledger?confirm=restore` | collectorのローカル台帳を失ったときの復元用。読み取り行数が多いので、`confirm=restore`が無いと400を返す。本文は先頭200字だけ。 |

## To Do

| パス | 用途 |
| --- | --- |
| `GET /api/todos/board?date=YYYY-MM-DD` | 日別ボードを返す。対象日の繰り返しタスクを重複なく生成する（テンプレート作成日より前の日付には生成しない）。 |
| `POST /api/todos/tasks` | 単発タスクを作成する。 |
| `GET/PATCH/DELETE /api/todos/tasks/:id` | タスク詳細、編集、論理削除。更新はversion競合を検出する。 |
| `POST /api/todos/tasks/:id/move` | リスト移動と並び順更新を行う。 |
| `GET/POST /api/todos/routines` | 繰り返しタスクの一覧と作成。 |
| `PATCH/DELETE /api/todos/routines/:id` | 繰り返しタスクの編集（タイトル・メモ・繰り返し設定・優先度）、停止・再開、論理削除。更新はversion競合を検出する。 |

## Manage Asset

| パス                                    | 用途                             |
| --------------------------------------- | -------------------------------- |
| `GET /api/manage-asset/state`           | 最新スナップショットと表示用集計 |
| `GET /api/manage-asset/history`         | 日次・通貨・保管場所別履歴。`days`で期間を絞る。`summary=1`を付けると、資産概要が使う項目（ID・日付・合計）だけを返す（約1/6のサイズ）。`fields=currency`を付けると、通貨推移が読む項目だけに削った行を返す（約半分のサイズ） |
| `POST /api/manage-asset/history-import` | 履歴データの移行                 |
| `POST /api/manage-asset/sync`           | collectorスナップショットの同期  |
| `GET /api/lido-rewards`                 | Lido報酬データ                   |
| `GET /api/usd-jpy-rates`                | 為替レート履歴                   |
| `GET /api/providers`                    | 取得元・保管場所情報             |

## ポータル・ストレージ

| パス                               | 用途                                 |
| ---------------------------------- | ------------------------------------ |
| `GET /api/portal/summary`          | ポータルホーム用の機能概要・最新状態 |
| `GET /api/settings/storage`        | D1/R2利用量、カテゴリ、上限警告      |
| `POST /api/cron/reconcile-storage` | R2台帳と利用量の日次照合             |

## 認証の扱い

ブラウザ操作はAccessの通常セッションを使用します。collectorの同期はAccess Service Authのclient ID/secretを使用し、外部APIキーを同期APIへ渡しません。認証失敗はデータ取得成功として記録しません。
