# アーキテクチャ

## コンポーネント

```text
Browser
  └─ Cloudflare Access
       └─ Workers (worker/auth-wrapper.ts)
            ├─ Vinext / React UI
            ├─ REST API (/api/items, /api/imports, /api/exports)
            └─ Cloudflare D1 (DB)
```

## データモデル

- `items`: コンテンツ本体、状態、日付、優先度、コメント、外部ソース識別子
- `item_links`: コンテンツに紐づく順序付き外部リンク
- `import_runs`: インポート実行結果

スキーマ定義は`db/schema.ts`、初期マイグレーションは`drizzle/0000_watch_list.sql`です。

## API

| Endpoint | 用途 |
| --- | --- |
| `GET /api/items` | 検索・絞り込み・ページング付き一覧 |
| `POST /api/items` | コンテンツ作成 |
| `PATCH /api/items/:id` | コンテンツ更新 |
| `DELETE /api/items/:id` | 論理削除 |
| `POST /api/imports` | 外部データの重複排除付きインポート |
| `GET /api/exports` | JSONまたはCSVエクスポート |
| `GET /api/stats` | 集計表示 |

## 設計上の判断

- D1を唯一の永続ストアとし、ブラウザにデータを保持しません。
- AccessはWorkerの前段で認証・認可を担い、アプリ内に認証情報を保持しません。
- 一覧は追加日降順、10件固定のページングで表示します。
