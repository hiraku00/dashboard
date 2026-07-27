# Watch List

個人用のコンテンツ鑑賞・管理アプリケーションです。映像、音声、テキストの候補をCloudflare D1に保存し、一覧・検索・編集・外部リンク・インポートを一つの画面で扱います。

## 機能

- 追加日降順の一覧、検索、種別・状態・人物／媒体による絞り込み
- タイトルからの編集、状態の行内変更、複数外部リンク、内容メモ
- 10件単位のページング、JSON／CSVエクスポート
- `POST /api/imports` による重複排除付き外部インポート
- Obsidian Markdownからの移行スクリプト
- Cloudflare Accessによる個人限定アクセス
- ポータル内のManage Asset（資産概要、保管場所、通貨推移、データ更新、設定）
- ポータル内のTextTube（一覧、Markdown／Mermaid対応の閲覧、Studio）

## 技術構成

- React 19 / Vinext / TypeScript
- Cloudflare Workers / Cloudflare D1
- Drizzle ORM

## ポータルとManage Asset

Manage Assetの画面は、既存の `/Users/hiraku/Practice/manage-asset/static/` を正典として移植しています。元画面の文言、表示桁数、グラフ、ホバー、ページング、保管場所の詳細展開を維持し、外側にポータル共通ヘッダーを追加しています。

外部APIの取得はローカルMacで実行し、APIキーはmacOS Keychainに保持します。Cloudflareへは取得済みスナップショットのみを同期します。D1には正規化データ、R2には必要な原本を保存します。

`/api/state`、`/api/history`、`/api/lido-rewards`、`/api/usd-jpy-rates`、`/api/providers` は、既存Manage Asset UIとの互換APIです。

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
