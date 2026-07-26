# 公開・認証手順

このプロジェクトはD1バインディング`DB`を利用するCloudflare Workersアプリケーションです。D1を作成して`wrangler.jsonc`へバインドし、`drizzle/0000_watch_list.sql`を1回適用してください。

個人専用にする場合は、Cloudflare AccessでWorkerの全パスを保護します。Self-hosted Applicationの対象をWorkerのProduction URLとPreview URLに設定し、Allowポリシーを必要なメールアドレスまたはIDプロバイダーのアカウントだけに限定します。アプリケーションはAccessの前段で保護されるため、認証トークンをアプリのコードやD1に保存しません。

外部取り込みは`POST /api/imports`を使います。JSONは`{ "sourceName": "...", "items": [...] }`形式で、`sourceSystem`と`externalId`の組み合わせは重複登録を防ぎます。

## 既存Markdownの移行

`node scripts/import-watch-list.mjs "/path/to/watch list (text, audio, movie).md" /tmp/watch-list.json`

生成JSONを確認してから、Accessで保護された`/api/imports`に送信します。移行スクリプトはMarkdownリンク、裸URL、`<br>`、エスケープ済み`\|`を保持し、元ファイルは変更しません。

## バックアップ

- `GET /api/exports?format=json`で定期的にJSONを保存する。
- D1 Time Travelに加え、大量インポート前には必ずJSONエクスポートする。
- 削除は論理削除なので、運用中の復元はD1コンソールかバックアップから行う。
