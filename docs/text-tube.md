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
- Supadataの応答ヘッダー `x-billable-requests` をD1の `text_tube_api_usage` に記録します。
- `/settings/storage` の「字幕API 使用量」と [Supadataダッシュボード](https://dash.supadata.ai) で実消費を確認できます。

## 移行

既存データの移行は `scripts/import-text-tube.mjs` を使用します。移行前にJSON/Markdown原本を保存し、件数、タイトル、本文、リンク、改訂版のR2キーを検証します。

## 確認項目

- Markdown表が列構造を保って表示される
- Mermaidが本文の途中で他要素を壊さない
- 目次クリックで該当見出しへ移動する
- 長文でもポータルヘッダーが固定表示される
- モバイル幅で表と本文が横溢れしない
