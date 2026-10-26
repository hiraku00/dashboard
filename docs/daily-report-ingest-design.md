# 作業日報（auto-daily-report）の取り込み設計

`~/Practice/auto-daily-report/outputs/daily_report_YYYY-MM-DD.md`（1日1ファイル、2026-10-22時点で204件、合計約610KB、最大約7KB）をdashboardへ取り込み、一覧・本文表示と集計に使えるようにする。本書は**データ投入部分だけ**を扱い、表示（画面・GET API）は別途検討する。

## 1. 結論（方式）

| 項目 | 決定 |
| --- | --- |
| 保存先 | **D1だけ**。原本のMarkdown（TEXT列）と、集計に使う正規化データ・タグを同じDBに置く。R2は使わない |
| 解析（パース）・タグ付け | **取り込み時にWorker側で行い、結果をD1に保存する**。表示時には計算しない |
| 送信側 | auto-daily-report から Markdown をそのまま `POST` する薄いクライアント |
| 認証 | Cloudflare Access の service token（scrape-tv-program と同じもの） |
| 重複・冪等性 | サーバー側で本文のsha256を比べ、同じ内容なら何も書かない。送信側は状態を持たない |
| 送らないもの | `logs/*.jsonl`（画面OCRの全文。76MB、個人情報・他人の発言・口座情報などを含む）、`daily_report_prompt.txt` |

### なぜこの形か（検討した案と比べて）

**原本の置き場所: D1のTEXT列（R2ではなく）**
- 1件が最大7KB、1年でも約1.5MBで、D1の容量（無料枠5GB、1行最大2MB）に対して十分に小さい。TextTubeの本文をR2に置いているのは数十〜数百KBになるためで、日報はその理由に当たらない。短い本文をD1に置く前例として、オープンチャットの `openchat_notes.body_text` がある。
- 原本と正規化データを**1回のD1 batch（トランザクション）**で書ける。R2とD1に分けると、片方だけ成功したときの不整合（R2に参照されないオブジェクトが残る、など）を考える必要がある。
- 1日分の本文表示も、再パース（§5.2）も、D1の読み取り1回で済む。

**解析とタグ付け: 取り込み時（表示時ではなく）**
- 読み込みは取り込み（1日1回程度）よりずっと多い。表示のたびに全件の文章へ規則を当てると、そのたびにCPUとD1の読み取りを使う。Workers無料枠のCPUは1リクエスト10msなので、期間の集計は前もって計算した値（§4.3）を `SUM` するだけにする。

**解析の場所: Worker側（Mac側のPythonではなく）**
- 規則（パーサー、タグ辞書、アプリ名の別名表）を直したとき、D1の原本から作り直せる。Macや送信側は関係しない。
- 解析結果の形（D1のスキーマ）と規則が同じリポジトリにあるので、両方を1つの変更で直せる。
- 4KB程度のMarkdownに正規表現を当てるだけなので、CPUは1件1ms未満。

**採らなかった案**
- **Markdownだけを保存し、表示時に解析する**: 前述のとおり読み込みのたびに計算が走る。
- **正規化データだけを保存する**: 原本が残らない。`outputs/` は `.gitignore` 対象でgit管理されていないため、Macのファイルが消えると戻せない。dashboardの原本は事実上のバックアップでもある。
- **Watch Listの `POST /api/imports` に載せる**: 「視聴・読書する項目」の表で、日報の各節を入れる列が無い。
- **日報の生成時に、LLMに構造化データ（JSON）も出させる**: 解析が不要になる利点はあるが、既存204件には無いのでパーサーは結局必要になり、経路が2つになる。生成はPerplexityをブラウザで操作しているので、出力形式が安定する保証も無い。新しい日報の精度が問題になったら、そのとき検討する。
- **送信側が登録済みの一覧（日付とsha256）を先に取得する**: 毎日の運用では、生成した1日分を送るだけなので不要。一括送信（`--all`）でも610KB・31リクエスト程度で、サーバー側がsha256で何も書かずに返すので、取得用のエンドポイントを増やす理由が無い。

## 2. 全体の流れ

```text
auto-daily-report                       dashboard Worker                         D1
┌─────────────────────────┐  service   ┌──────────────────────────────┐
│ daily_report.py で生成   │  token     │ POST /api/daily-reports       │
│ → 生成した日付を送る     │──────────▶│ ① 検証・sha256計算            │
│ (手動: append / --all)   │ ≤20件/回  │ ② 同じsha256なら何もしない    │
└─────────────────────────┘           │ ③ パース＋タグ付け            │
                                      │ ④ 1回のbatchで書く ──────────┼──▶ daily_report*
                                      └──────────────────────────────┘
```

## 3. D1スキーマ

migration `0017_daily_reports.sql` と `db/index.ts` の `ensureSchema()` の**両方**に追加し、`SCHEMA_VERSION` を上げる（docs/architecture.md のルール）。どのテーブルも `report_date`（`YYYY-MM-DD`）で引けるようにする。

### 3.1 `daily_reports`（1日1行）

| 列 | 型 | 内容 |
| --- | --- | --- |
| `report_date` | TEXT PK | ファイル名の日付（本文の `# 作業日報 YY-MM-DD` は照合用。食い違えば警告） |
| `markdown` | TEXT | 原本 |
| `sha256` | TEXT | 原本のハッシュ（再送の判定） |
| `record_start` / `record_end` | TEXT | `HH:MM`（`記録期間:` から） |
| `recorded_minutes` | INTEGER | 記録期間の分数 |
| `capture_count` / `capture_count_is_min` | INTEGER | `キャプチャ回数`。「N回以上」「N+回」は下限値として入れ、`is_min=1` |
| `gap_minutes` | INTEGER | 「ログなし」行の合計分 |
| `parser_version` | INTEGER | 解析・タグ付けに使った規則の版 |
| `parse_status` / `parse_warnings` | TEXT / TEXT | `ok`・`partial`・`failed` / 警告のJSON配列 |
| `created_at` / `updated_at` | TEXT | ISO8601 |

`parse_status='failed'` でも行と原本は保存する（表示側は本文だけ出せる）。

### 3.2 `daily_report_revisions`（書き直し前の原本）

`report_date`, `revision_number`, `markdown`, `sha256`, `replaced_at`。内容が変わった再送のときに、**差し替えられる前の原本**を1行追加する。集計には使わず、誤って上書きしたときに戻すためだけに持つ（`outputs/` がgit管理されていないため）。

### 3.3 正規化テーブル（取り込みのたびに、その日付の分を作り直す）

日付ごとに最新の内容で置き換える。日付ごとに1つずつ残るので、週・月・年の集計に必要な履歴は失われない。PKは `report_date` + `position`。

| テーブル | 元の節 | 主な列 | 正規化する理由 |
| --- | --- | --- | --- |
| `daily_report_work_items` | 1. 本日のメイン作業 | `category_position`, `category`（`###` 見出し、番号は除く）, `item_position`, `text` | タグ付けと「何をしたか」の期間集計 |
| `daily_report_app_usage` | 2. アプリ使用状況 | `app_name`（原文）, `app_key`（§3.5）, `usage_count`, `usage_count_raw`, `usage_is_min`, `purpose` | アプリ別の推移 |
| `daily_report_time_blocks` | 3. 作業詳細 | `start_minute` / `end_minute`（0時からの分、日付をまたげば>1440）, `activity`, `duration_minutes`, `is_gap` | タグ別の時間の元データ、時間帯の分布 |
| `daily_report_notes` | 4. 得られた知見・メモ | `text` | 日をまたいだ知見の一覧・検索 |

「5. 作業中だったファイル」は正規化しない。日をまたいで集計する用途が無く（何に取り組んだかはタグで分かる）、1日分の表示は原本で足りる。必要になれば、再パース（§5.2）で後からテーブルを追加できる。

### 3.4 タグ

| テーブル | 主な列 | 用途 |
| --- | --- | --- |
| `daily_report_item_tags` | `report_date`, `source`（`work`/`time`）, `position`, `tag` | どの作業項目・時間帯にどのタグが付いたか（明細、絞り込み用） |
| `daily_report_tag_days` | PK(`report_date`,`tag`), `minutes`, `work_item_count` | **前もって計算した1日×タグの合計**。週・月の集計はこの表の `SUM` だけで済む（1年で約3,000行） |

タグ付けの規則（`app/lib/daily-report-tags.ts`、コード内の辞書）:

- タグの一覧と当てる語は `app/lib/daily-report-tags.ts` の `DAILY_REPORT_TAGS` が正（学習・開発・お金・生活・視聴の5グループ、20タグ）。既存204件の `###` 見出しと時間帯の作業内容を頻度順に並べて作った。
- このリポジトリは公開なので、辞書には個人の口座・取引先・地名のような固有名詞を入れず、一般的な語（口座、物件、航空券など）で当てる。
- 一括送信の前に `node scripts/check-daily-reports.mjs <outputsのパス>` で、全件の解析結果とタグ別の時間（`other` の割合）を確かめる。

- 当てる対象は作業項目（`###` 見出し＋箇条書き。見出しのタグは配下の箇条書きにも付ける）と、時間帯の作業内容。複数のタグが付いてよい。
- `minutes` は時間帯から数える。1つの時間帯に複数のタグが付いたら所要時間を**タグの数で等分**する（1日の合計が記録時間−欠落時間を超えないようにするため）。どれにも当たらない時間は `other`、`（ログなし）` の行は数えない。
- 辞書をD1ではなくコードに置くのは、1人で使うアプリで編集画面が不要なため。変えたときはテストで確認し、デプロイ後に再パース（§5.2）で全件へ反映する。

### 3.5 アプリ名の正規化（`app_key`）

「Claude Code／ros2_ws」「Gemini／Anki」のような揺れがあるので、`／` `/` で分けた先頭の要素を小文字化・空白除去し、別名表（`claude.ai`→`claude` など）で寄せる。

### 3.6 集計の例（表示側の参考。本書の対象外）

- 直近1週間・1か月に何をどれだけやったか: `daily_report_tag_days` を期間で絞り、`tag` ごとに `SUM(minutes)`
- アプリ別の使用回数の推移: `daily_report_app_usage` を `app_key` で集計
- 月別の記録時間・欠落時間: `daily_reports` の `recorded_minutes` / `gap_minutes`

## 4. 解析（`app/lib/daily-report-parse.ts`）

- `parseDailyReport(markdown, date)` と `tagDailyReport(parsed)` の純関数。`PARSER_VERSION` を定数で持ち、パーサー・タグ辞書・別名表のどれを変えても上げる。
- 節は `^## \d+\.` の見出しで分け、**番号とキーワードの両方**で判定する（「知見･メモ」と「知見・メモ」が混在しているため）。
- 既存204件で実際に見つかった表記の揺れ: `~`/`～`、半角・全角の括弧、`約 N 時間`（分なし）、`HH:MM:SS`、`N回以上`・`N+回`・`N 回`・`:N回[N]`、`## 2. アプリ使用状況(アプリ、使用回数、主な用途)` のような補足付きの見出し。
- 表は1行目の列名で列を特定し、列の順番には頼らない。
- 読めない行は飛ばして `warnings` に入れ、`partial` にする。例外で全体を落とさない。
- テスト（`tests/daily-report-parse.test.mjs`、`tests/daily-report-tags.test.mjs`）は、実際の日報が個人的な内容を含むため、書式（初期の形式、見つかった表記揺れ）だけを写した**架空の日報**をfixtureにする。一括送信の前に、**既存204件の全件で `failed` が0件**であることと、`other` に落ちる時間の割合を確認する。

## 5. API（すべて service token のみ。ブラウザからは呼ばない）

### 5.1 `POST /api/daily-reports`

```json
{ "reports": [ { "date": "2026-10-21", "markdown": "# 作業日報 26-10-21\n…" } ] }
```

- 1リクエスト最大**20件**、1件最大**64KB**（現状最大7KB）。
- 各件: 日付と本文を検証 → sha256を計算 → 登録済みと同じなら `skipped`（**何も書かない**）→ 解析・タグ付け → **1回のbatch**で「書き直し前の原本を `daily_report_revisions` へ退避」「`daily_reports` のupsert」「正規化・タグの当日分をDELETE→INSERT」。batchはトランザクションなので、途中で失敗すれば前の内容が残る。
- sha256はクライアントから受け取らない（サーバーで計算すれば一致の確認も要らない）。
- レスポンスは件ごとの結果。1件の失敗で全体を400にしない。

```json
{ "created": 1, "updated": 0, "skipped": 0, "errors": 0,
  "results": [ { "date": "2026-10-21", "status": "created", "parseStatus": "ok", "warnings": [] } ] }
```

### 5.2 `POST /api/daily-reports/reparse`

`parser_version` が古い日報を、D1の原本から最大20件ずつ解析し直し、`{ "remaining": n }` を返す。送信側のコマンドが `remaining` が0になるまで繰り返し呼ぶ（cronで少しずつ進める案は、204件の反映に何日もかかるので採らない）。

### 5.3 `DELETE /api/daily-reports/:date`

間違って送った日報を消す（正規化・タグ・改訂を含む）。`{ "deleted": date }`。無ければ404、日付の形が違えば400。

- 取り込みと同じく service token だけで受け付ける。ブラウザでログインした人からは403になり、画面にも削除ボタンは置かない（消すのは送信側の誤りを直すときだけで、頻度が低い。送った側の手元から消すほうが、手元の Markdown と D1 の食い違いに気づきやすい）。
- 消すときは送信側の `python sync_dashboard.py --delete YYMMDD` を使う（§6）。元に戻せないので、`--dry-run` で日付を確かめてから実行する。

## 6. 送信側（auto-daily-report）

```bash
python daily_report.py --date 261021      # 生成して保存した直後に、その日付を自動で送る
python sync_dashboard.py 261021           # 指定した日付だけ送る（再送・手直し後）
python sync_dashboard.py --all            # outputs/ の全件（一括送信、まとめて書き直した後）
python sync_dashboard.py --reparse        # 規則を変えてデプロイした後、全件を作り直させる
python sync_dashboard.py --delete 261023  # 間違って送った日報を消す（§5.3、複数指定・--dry-run 可、--all とは併用不可）
```

- 送信処理は `src/dashboard_sync.py`。HTTPの部分（`urllib` + `certifi`、`.env` の service token をヘッダーに付ける）は scrape-tv-program の `core/watch_list_api.py` と同じ書き方にする。
- 状態ファイルは持たない（再送してもサーバー側で `skipped` になるだけ）。
- `--delete` は D1 から消すだけで、送信側の `outputs/` の Markdown は消さない。残したまま `--all` で送ると、その日報はもう一度登録される。
- `daily_report.py` からの自動送信が失敗しても、日報の保存は失敗扱いにしない。エラーを表示し、手で `sync_dashboard.py <日付>` を実行する。

## 7. 容量・無料枠の見積もり

| 項目 | 見積もり |
| --- | --- |
| D1の容量 | 原本 約1.5MB/年＋正規化・タグ 約3万行/年 → 数MB/年（無料枠5GB） |
| D1の書き込み | 1日分で約80行。一括送信204件で約1.6万行（無料枠10万行/日）。`skipped` は0 |
| CPU | 1件の解析＋タグ付けは1ms未満。20件/リクエストで10ms以内の想定（実装後に `wrangler tail` で確認し、超えるなら件数を下げる） |

## 8. 実装の順序

進捗（2026-10-22）: 1〜4は実装済み。6のうちdashboardのdocsは3・4と一緒に更新した。5はauto-daily-report側で進める。週次・月次サマリの取り込み（§10）も実装済み。

1. パーサーとテスト（既存204件で `failed` 0件）
2. タグ辞書の作り込み（既存204件の頻度から）とテスト
3. migration `0017_daily_reports.sql`、`ensureSchema()`、`SCHEMA_VERSION`
4. `POST /api/daily-reports`、`/reparse`、`DELETE`（`app/api/daily-reports/**/route.ts`）
5. auto-daily-report の `sync_dashboard.py` で一括送信し、`daily_report.py` から自動送信
6. docs（`data-model.md`、`api-reference.md`、`architecture.md` の「主要なデータ境界」表）を更新

## 9. 未確定の点

- 日報には口座・確定申告・閲覧サイトなど個人的な内容が含まれる。dashboardはAccessで保護されていて本人だけが見る前提だが、共有用のリンクや画面を作るときは配慮が要る。
- 正規表現の辞書によるタグ付けの精度。`other` の割合が高すぎる、または誤ったタグが目立つ場合は、辞書を見直すか、生成時にLLMにタグを付けさせる案（§1の採らなかった案）を検討する。

## 10. 週次・月次サマリ

auto-daily-report の `summarize.py` が、期間内の日報から週次・月次のサマリ（Markdown）を `claude -p` で作る。送信側は週末・月末にサマリを作り、日報と同じ service token で送る。

- 本文は「# 週次サマリ …」（月次も同様）の見出しと、「## 1. 概要」「## 2. 主な取り組み」「## 3. 成果・進捗」「## 4. 得られた知見」「## 5. 次に向けて」の5節。1件はおおむね5〜10KB。
- 日報から作った二次的な文章で、集計は日報の正規化データで足りるので、**解析・タグ付けはせず原本をそのまま保存する**。改訂も残さない（作り直せばよい）。
- `/daily-report` の週次・月次の「原本」タブに、日報の一覧と並べて表示する（[表示設計 §4.6](daily-report-view-design.md)）。

### 10.1 テーブル `daily_report_summaries`

`migrations/0018_daily_report_summaries.sql`、schema version 14。

| 列 | 内容 |
| --- | --- |
| `kind` | `week`（月曜〜日曜）か `month`（1日〜末日） |
| `period_start` / `period_end` | `YYYY-MM-DD`。主キーは (`kind`, `period_start`) |
| `markdown` / `sha256` | 原本とそのsha256（サーバーで計算） |
| `created_at` / `updated_at` | ISO 8601 |

### 10.2 `POST /api/daily-report-summaries`

```json
{ "summaries": [ { "kind": "week", "periodStart": "2026-10-12", "periodEnd": "2026-10-18", "markdown": "# 週次サマリ …" } ] }
```

- 1リクエスト最大**20件**、1件最大**64KB**。
- 週は `periodStart` が月曜で `periodEnd` がその6日後、月は `periodStart` が1日で `periodEnd` がその月の末日。合わなければその件を `error` にする。
- sha256が登録済みと同じなら `skipped`（何も書かない）、変われば上書きする。1件の失敗で全体を400にしない。

```json
{ "created": 1, "updated": 0, "skipped": 0, "errors": 0,
  "results": [ { "kind": "week", "periodStart": "2026-10-12", "status": "created" } ] }
```

### 10.3 `DELETE /api/daily-report-summaries/:kind/:periodStart`

間違って送ったサマリを消す。`{ "deleted": { "kind", "periodStart" } }`。無ければ404。
