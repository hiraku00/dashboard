# API一覧

すべてのAPIはWorker配下の認証済みルートです。本番ではCloudflare Accessを経由し、ブラウザの通常操作とcollectorのService Authを区別します。正確な入力スキーマは各route実装を正とします。

## Watch List

| パス                                   | 用途                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/items`                       | 検索、絞り込み、ページング付き一覧                                                                                                |
| `POST /api/items`                      | 項目作成                                                                                                                          |
| `POST /api/watch-list/youtube-preview` | 公開YouTube動画URLから、チャンネル名・タイトル・正規化リンクを取得して入力用データを返す。YouTube Data APIやAPIキーは使用しない。 |
| `GET /api/items/:id`                   | 項目詳細                                                                                                                          |
| `PATCH /api/items/:id`                 | 項目更新                                                                                                                          |
| `DELETE /api/items/:id`                | 論理削除                                                                                                                          |
| `GET /api/history`                     | 変更/インポート履歴                                                                                                               |
| `GET /api/stats`                       | 一覧用集計                                                                                                                        |
| `POST /api/imports`                    | Watch Listデータのインポート                                                                                                      |
| `GET /api/exports`                     | バックアップ用エクスポート                                                                                                        |
| `GET /api/state`                       | アプリ状態・移行状態                                                                                                              |

## TextTube

| パス                                      | 用途                                                                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/text-tube/videos`               | 検索・一覧                                                                                                                                                  |
| `POST /api/text-tube/videos`              | コンテンツ作成                                                                                                                                              |
| `GET /api/text-tube/videos/:id`           | コンテンツ詳細                                                                                                                                              |
| `PATCH /api/text-tube/videos/:id`         | メタデータ更新                                                                                                                                              |
| `DELETE /api/text-tube/videos/:id`        | コンテンツ削除                                                                                                                                              |
| `POST /api/text-tube/videos/:id/document` | Markdown本文・revision保存                                                                                                                                  |
| `POST /api/text-tube/youtube-preview`     | YouTube Data API v3でメタデータ、Supadataで既存YouTube字幕を取得してTextTube入力用データを返す。`YOUTUBE_DATA_API_KEY` と `SUPADATA_API_KEY` Secretが必要。 |
| `GET /api/settings/storage`               | R2使用量に加え、TextTube字幕APIの実消費クレジット・取得試行・最終取得日時を返す。                                                                           |

## Manage Asset

| パス                                    | 用途                             |
| --------------------------------------- | -------------------------------- |
| `GET /api/manage-asset/state`           | 最新スナップショットと表示用集計 |
| `GET /api/manage-asset/history`         | 日次・通貨・保管場所別履歴       |
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
