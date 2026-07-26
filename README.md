# Watch List

個人用のコンテンツ鑑賞・管理アプリケーションです。映像、音声、テキストの候補をCloudflare D1に保存し、一覧・検索・編集・外部リンク・インポートを一つの画面で扱います。

## 機能

- 追加日降順の一覧、検索、種別・状態・人物／媒体による絞り込み
- タイトルからの編集、状態の行内変更、複数外部リンク、内容メモ
- 10件単位のページング、JSON／CSVエクスポート
- `POST /api/imports` による重複排除付き外部インポート
- Obsidian Markdownからの移行スクリプト
- Cloudflare Accessによる個人限定アクセス

## 技術構成

- React 19 / Vinext / TypeScript
- Cloudflare Workers / Cloudflare D1
- Drizzle ORM

詳細は[アーキテクチャ](docs/architecture.md)、公開と認証は[運用手順](docs/deployment-and-access.md)を参照してください。

## ローカル開発

前提: Node.js 22.13以上、CloudflareアカウントへのD1アクセス権限。

```bash
npm ci
npm run dev
npm test
```

`wrangler.jsonc` のD1バインディング `DB` を利用します。ローカルで別のD1を使う場合は、`vite.config.ts` と `wrangler.jsonc` の識別子を自分の環境に合わせて変更してください。

## デプロイ

```bash
npx wrangler d1 migrations apply hiraku-watch-list --remote
npx wrangler deploy --config wrangler.jsonc
```

本番公開前にCloudflare AccessのSelf-hosted ApplicationとAllowポリシーを設定してください。認証手順は[運用手順](docs/deployment-and-access.md)に記載しています。

## データ移行・インポート

ObsidianのMarkdown一覧をJSONに変換します。

```bash
node scripts/import-watch-list.mjs \
  "/path/to/watch list (text, audio, movie).md" \
  /tmp/watch-list.json
```

生成したJSONは確認後に`POST /api/imports`へ送信します。`sourceSystem`と`externalId`の組み合わせで重複を防ぎます。

## セキュリティ

- 本番アクセスはCloudflare Accessで保護します。
- 秘密情報、`.env*`、`.dev.vars*`、Wranglerのローカル状態はコミットしません。
- 脆弱性の報告は[SECURITY.md](SECURITY.md)に従ってください。

## ライセンス

[MIT License](LICENSE)
