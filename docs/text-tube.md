# TextTube運用

## 画面構成

- `/text-tube`: ライブラリ。検索、並び替え、ステータス/種別フィルタ、詳細への導線
- `/text-tube/studio`: 新規登録・編集。メタデータ、リンク、詳細Markdownを扱う
- `/text-tube/watch/:id`: 読書画面。固定ポータルヘッダーの下で本文を閲覧する

TextTubeは単独アプリではなく、ポータルの共通ヘッダー・認証・保存基盤を利用する機能です。元の画面構成をベースにしつつ、色、余白、幅、ナビゲーションはポータルのデザインシステムに合わせます。

## Markdown表示

詳細本文はMarkdownとして保存・表示します。少なくとも以下を表示対象とします。

- 見出しと目次アンカー
- 強調、引用、箇条書き、リンク
- GitHub Flavored Markdownの表
- fenced code block
- Mermaidコードブロック

目次リンクは本文内の見出しに対応する安定したIDへ移動します。見出しIDの生成規則を変更すると既存リンクに影響するため、変更時は既存記事を含む画面テストを行います。

## 保存構成

- D1: タイトル、チャンネル、説明、ステータス、種別、公開日、検索用メタデータ
- R2: 詳細Markdown本文と改訂版
- D1のrevision情報: R2キー、版、サイズ、更新日時など

本文の編集では、メタデータ更新と本文オブジェクト更新のどちらか一方だけが成功した状態を避けます。失敗時はrevisionの整合性を確認し、必要に応じて再保存します。

## YouTube URL取り込み

Studioの「動画情報を取得」は、YouTube Data API v3で動画メタデータを、SupadataでYouTube標準字幕を取得します。字幕はタイムスタンプ付きMarkdownに変換し、保存時にR2へ格納します。

- Cloudflare Secret: `YOUTUBE_DATA_API_KEY`、`SUPADATA_API_KEY`
- 字幕取得は `mode=native` に固定し、AI文字起こしへ自動フォールバックしません。
- まず動画本来の言語（YouTube Data APIの`snippet.defaultAudioLanguage`、無ければ英語とみなす）で取得します。翻訳された字幕より、その言語のネイティブな字幕（人手またはYouTube自身の音声認識）のほうが精度が高いためです。動画本来の言語での取得に失敗した場合、Supadataは代わりに「最初に見つかった言語」を返す（動画の言語へはフォールバックしない）ため、それが英語以外で英語字幕が存在するときは`lang=en`で1回だけ再取得します（Supadataへのリクエストは合計2回、使用量もそのぶん記録されます）。動画本来の言語・英語のどちらも取得できなかった場合のみ、実際に取得できた言語のまま保存し、その旨を画面に通知します。
- Supadataの応答ヘッダー `x-billable-requests` をD1の `text_tube_api_usage` に記録します。
- `/settings/storage` の「字幕API 使用量」と [Supadataダッシュボード](https://dash.supadata.ai) で実消費を確認できます。

## Watch Listからの自動登録

Watch ListにYouTube動画のURLを含む項目を保存する（新規追加、または既存項目の編集でYouTubeリンクを新しく追加する）と、その動画をTextTubeへ自動で取り込みます。実装は`app/lib/text-tube-import.ts`（`runTextTubeImport()` / `pendingTextTubeImports()`）で、上記「YouTube URL取り込み」と同じ`app/lib/youtube-video-fetch.ts`（動画情報＋字幕の取得）、`app/lib/text-tube-document.ts`（本文のR2保存）を呼びます。取り込むのは動画情報と字幕だけで、**要約は空のまま保存します**（AIによる自動要約は行わず、あとで人が手動で書く前提の設計です）。

- 対象は`POST /api/items`・`PATCH /api/items/[id]`経由の保存のみです。一括インポート（`POST /api/imports`）は対象外です（Supadataの無料枠は月100回程度が目安で、一括インポートの規模で使い切ってしまうため）。
- PATCHでは、その保存で**新しく追加されたリンクだけ**が対象です。既にあったリンクへの状態変更などでは再登録しません。
- 既にTextTubeにある（削除されていない）動画は登録し直しません。TextTube側で削除した動画は、Watch Listで該当リンクを含む項目を再度保存すれば再登録されます。
- 実行の記録はD1の`text_tube_imports`テーブルに残します（`running`/`done`/`failed`、`youtube_video_id`ごとに複数行残り得るため「今の状態」は`updated_at`が最新の1行で判断）。10分以上`running`のまま進んでいない行は「stuck」として扱い、手動での再試行を促します。**cronによる自動再実行は行いません** -- 登録中にタブを閉じた場合は、Watch List上部の帯、または編集画面の「TextTube」欄にある「TextTubeへ反映」ボタンで手動に再試行します。
- Watch Listの一覧・編集画面での見え方は[docs/routes-and-features.md](routes-and-features.md)の「TextTubeへの自動登録」を参照してください。
- `text_tube_videos.youtube_video_id`列で「この動画は既にTextTubeにあるか」を判定します。列の追加と既存行のバックフィルは`ensureSchema()`が行います（`items.thumbnail_url`と同様、migrationには含めません）。

## 移行

既存データの移行は `scripts/import-text-tube.mjs` を使用します。移行前にJSON/Markdown原本を保存し、件数、タイトル、本文、リンク、改訂版のR2キーを検証します。

## 確認項目

- Markdown表が列構造を保って表示される
- Mermaidが本文の途中で他要素を壊さない
- 目次クリックで該当見出しへ移動する
- 長文でもポータルヘッダーが固定表示される
- モバイル幅で表と本文が横溢れしない
