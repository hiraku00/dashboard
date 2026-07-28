# システム概要

## 目的

このリポジトリは、複数機能を一つの認証済みダッシュボードへ集約するためのアプリケーションです。初期のWatch Listから始まり、現在はTextTube、Manage Asset、ストレージ管理を含むダッシュボードとして運用します。

## 設計原則

1. ブラウザで操作する機能はCloudflare Accessの内側に置く。
2. 検索・一覧・集計に必要な構造化データはD1に保存する。
3. Markdown本文、原本、サイズの大きいファイルはR2に保存する。
4. APIキーを使う外部データ取得はMac上で行い、秘密情報をWorkerへ置かない。
5. 取得処理と表示処理を分離し、取得失敗時も前回成功したスナップショットを確認できるようにする。
6. UIは機能ごとの既存仕様を尊重し、共通ヘッダー・認証・データ基盤だけをポータルとして共通化する。

## 機能の責務

| 機能 | 主な責務 | 主な保存先 |
| --- | --- | --- |
| Watch List | 視聴候補の登録、検索、状態・優先度管理 | D1 |
| TextTube | コンテンツライブラリと詳細Markdown | D1 + R2 |
| Manage Asset | 資産スナップショット、履歴、配分、通貨推移 | D1 |
| Collector | 外部APIからの資産取得と同期 | Mac + D1 |
| Storage | D1/R2の容量・日次使用量の可視化 | D1 + R2 |

## データフロー

### ブラウザ操作

ブラウザ → Cloudflare Access → Worker → 認証済みUI/API → D1/R2

### 資産データ取得

launchd → collector → macOS KeychainからAPIキー取得 → 外部サービス → スナップショット生成 → Access Service Auth → Worker API → D1

collectorが外部サービスへ直接アクセスするため、外部APIキーはCloudflareへ送信しません。Workerへ送るのは同期対象の資産データです。

## 信頼境界

- **Mac**: APIキーとService Tokenを保持する信頼された取得環境
- **Cloudflare Access**: ブラウザ利用者とcollectorの入口を制限
- **Worker**: Access後の認証済みリクエストだけを処理
- **D1/R2**: Worker経由で読み書きする永続ストレージ
- **外部API**: collectorが個別の認証情報でアクセスする外部システム

## 命名

GitHubリポジトリは `hiraku00/dashboard` です。Worker/D1/R2の既存名は運用中の識別子なので、GitHubリポジトリ名の変更では変更されません。
