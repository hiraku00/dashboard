# ちきりんオプチャ 設計

LINEオープンチャット「集まれテレビっ子」のノート（1ノート＝1番組）から、ちきりんの投稿を取り出してポータルに保存・表示する機能の設計。Watch List / TextTube と並ぶ新機能として実装する。

- 状態: 実装済み（フェーズ1: 手動実行）。2026-09-24 に検証し、`collector/line_openchat/`、Worker API、`/chikirin` 画面、テストまで入っている。launchdでの定期実行（フェーズ2）は未実装
- 検証スクリプト（初期の検証用）: `work/line-openchat-poc/`（Git管理外）。本実装はこれを作り直したもの
- 実装と設計の違いは、末尾の「実装メモ」を参照
- OCR方式: macOS標準の Vision による文字認識（Claude APIは使わない）

## 1. 何を取るか

| 対象 | 保存 | 画面表示 |
|---|---|---|
| ちきりんが立てたノートの本文（全文） | する | する |
| どのノートでも、ちきりんが書いたコメント（1ノートに複数あれば全部） | する | する |
| ちきりんのコメントがあるノートの、スレッド主の投稿（番組の情報。本文・投稿者・日時） | する | する（番組カードの上部に「スレッド主の投稿」として表示。検索の対象） |
| ちきりんが関わらないノートの情報（投稿者・日時・本文・コメント数） | する | しない（取得済みかどうかの判定用） |
| ちきりん以外のコメント | する | しない（重複判定・件数照合・削除検知用） |

ちきりん以外の投稿を保存するのは、差分取得を正確にするため（ユーザー了承済み）。画面とAPIに出すのは、ちきりんが関わるノートの、スレッド主の投稿（番組の情報）まで。ちきりん以外の**コメント**、ちきりんが関わらないノートは、画面にもAPIにも出さない。

### ちきりんが関わる場合の組み合わせ

1つのノート（番組）について、次のどれも起こりうる前提で設計する。

1. **他の人のノート**に、ちきりんがコメントを1回書く
2. **他の人のノート**に、ちきりんがコメントを**複数回**書く（間に他の人のコメントが入ることもある）
3. **ちきりんが立てたノート**で、コメントはない
4. **ちきりんが立てたノート**に、本人がさらにコメントを1回以上書く（補足・返信）
5. どちらもなし → 画面には出さない（保存のみ）

画面では1ノート＝1番組のカードにまとめ、「ちきりんの本文（3・4のとき）」と「ちきりんのコメント（投稿時刻の古い順に全部）」を並べる。

## 2. 全体の構成

```
Mac（ログイン中・画面ロックなし）
  collector/line_openchat/
    sync.py        … 実行の入口（手動実行）。前提の確認、台帳の読み書き、Portalへの送信
    session.py     … 差分取得の本体。一覧を上から読み、変わったノートだけ開く（コメント欄の展開は1画面ずつ、読み取りは下の3つ）
    capture.py     … 開いたコメント欄を下へ撮り進め、画素の一致だけでずれを測って1枚の縦長画像につなぐ（文字で位置合わせしない）
    tallocr.py     … 縦長画像を重なり付きのタイルに分けてVisionで読む（1回目と、境目をずらした2回目を合成）
    tallparse.py   … 縦長画像のOCR結果 → ノート／コメントのブロック（時刻の読み違えは、行を拡大して読み直す）
    threadread.py  … 上の3つをつなぐ、コメント欄1つぶんの読み取り
    safety.py      … LINEは参照のみ、を機械的に守る仕組み（許可した4種類の操作だけ、押す前に画面で確認）
    lineui.py      … macOS専用。ウィンドウの特定・スクロール・撮影・Vision OCR・ユーザー操作の検知
    parse.py       … OCR結果と画素 → ブロックの共通部品（数の行の読み取りなど）。一覧の走査では1画面ずつにも使う
    layout.py      … 寸法・色の実測値（LINEの見た目が変わったらここだけ直す）
    identity.py    … 同じノート・コメントかどうかの判定（OCRの揺れを吸収）
    ledger.py      … 取得済み台帳（ローカルJSON。原子的に保存）
    timeparse.py   … 「N時間前」「昨日 午後9:46」などのLINEの時刻表示 → UTCと精度
    uploader.py    … Portalへの送信（Service Token。manage-assetと同じ方式。小さく分割して送る）
  collector/data/line_openchat/
    ledger.json    … 取得済み台帳（Git管理外）
    run-<日時>.log … 実行ログ（7日で削除）
        │ HTTPS + Cloudflare Access Service Token
        ▼
Cloudflare Worker
  POST /api/openchat/sync            … start / notes / complete
  GET  /api/openchat/ledger          … 台帳の復元用（ローカル台帳を失ったときだけ）
  GET  /api/openchat/programs        … 画面用一覧（ちきりんの投稿があるノートだけ）
  D1: openchat_notes / openchat_comments / openchat_sync_runs
  画面: /chikirin
```

### 取得済みの判定は「ローカル台帳」で行う

- 毎回の差分判定は collector 側の `ledger.json` で行い、D1を読まない。D1の1日の読み取り上限を使わないため（2026-09-21に上限を使い切って本番が止まったことがある）。
- `ledger.json` が無いときだけ、`GET /api/openchat/ledger` から1回で復元する。
- D1は表示用のデータ、および台帳のバックアップという位置づけ。

## 3. 実行の前提と実行方法

### 前提（`sync.py` が開始時に確認し、満たさなければ何もせずに終了する）

| 条件 | 確認方法 | 満たさない場合 |
|---|---|---|
| LINEが起動している | `NSRunningApplication`（bundle `jp.naver.line.mac`） | 終了（exit 2） |
| 画面がロックされていない | `CGSessionCopyCurrentDictionary()["CGSSessionScreenIsLocked"]` | 終了（exit 3） |
| ノートウィンドウが開いている | AXタイトルが空で幅300〜700ptの縦長ウィンドウ（`find_note_window`） | 終了（exit 5）。**自動では開かない**（LINEを参照のみに保つため、本体ウィンドウのアイコンは押さない。あらかじめLINEでノートを開いておく） |
| 対象のオープンチャットのノートである | （未実装）ノートウィンドウにはチャット名が出ないため確認できない。ノートを開いたチャットが正しいことは、実行する人が確かめる | ― |
| ウィンドウ幅が428pt、ダーク表示 | CGWindowの幅、背景色 `#2D2E30` | 警告を出して続行。座標の定数がずれるので、結果は要確認扱いにする |
| Python（`/usr/local/bin/python3`）にアクセシビリティ許可がある | `AXIsProcessTrusted()` | 終了。許可の手順を表示 |

### 実行方法

- **フェーズ1（まずはこれ）**: 手動実行 `python3 collector/line_openchat/sync.py`。実行中はマウスを操作するので、数分間Macを触らないこと。
- **フェーズ2（任意）**: launchdで1日1回、次の条件を満たすときだけ動かす。
  - 画面ロックなし、かつ操作していない時間が10分以上（`ioreg -c IOHIDSystem` の `HIDIdleTime`）
  - 実行中にユーザーがマウスやキーボードを触ったことを検知したら（`HIDIdleTime` の減少）、すぐ中断する。中断しても台帳はノート単位で保存しているので、次回はその続きから始まる。
- 新しいPythonの依存パッケージは無い（`pyobjc` の Vision / Quartz / ApplicationServices は導入済み）。依存を追加するときは、launchdが使う `/usr/local/bin/python3` にもインストールする。

## 4. 画面の読み取り（検証スクリプトで確認した値）

撮影は `screencapture -x -o -l <windowId>`（ほかのウィンドウに隠れていても撮れる。画像はRetinaの2倍解像度）。以下の座標はノートウィンドウの左上を原点とする pt 単位。すべて `parse.py` の定数としてまとめる。

| 項目 | 値・判定方法 |
|---|---|
| 背景色 | `#2D2E30`（RGBの差の合計が30以内なら背景とみなす） |
| 時刻行 | 正規表現 `N秒前 / N分前 / N時間前 / 今 / 昨日 午後H:MM / 一昨日 … / M.D 午後H:MM / YYYY.M.D 午後H:MM`。時刻行が1ブロックの終わり |
| ノートかコメントか | 時刻行の x < 32 → ノート、x ≈ 49 → コメント |
| 作者行 | アバター（x=16〜40）に何か描かれている行が縦に**22〜34pt連続**し、かつ x=10 と x=47.5 が背景色（バッジが x≈45 まで張り出すため 47.5。名前の文字は x≥49）。文字行は約15ptごとに行間で途切れ、リンクカード・検索欄・「大事なノート」帯は35ptを超えるので除外される |
| 作者名 | アバターと同じ高さで、40 < x < 80 から始まるOCR行。取れなければその範囲だけ再OCR。先頭の記号（`）` `©` `•` など）は取り除く |
| 公式バッジ（ちきりん判定） | アバターの下側45%〜下端+6pt、x=32〜49 の範囲に、青い画素（R<40, 90≤G≤180, B≥235）が40pt²以上。実機では `#0070FF` の単色と `#00A4FF→#0096FF` の縦グラデーションの両方があった |
| ブロックが完全かどうか | ブロック内に作者行があれば完全。画面の上端から30pt以内のアバターは、切れている可能性があるので不完全とする |
| 本文 | ノート: 作者行より下で x < 32 の行。x > 100 の行はリンクカード（`link_title` に入れる）。コメント: 作者行より下の行 |
| 右端の小さな文字 | x > 330 かつ幅 < 70 の行（いいね数など）は捨てる |
| 「もっと見る」 | ノート本文の続きを開くボタン。ちきりんのノートの場合だけ押す（x=60, 該当行のy） |
| 「前のコメントを見る」 | コメント欄の途中の区切り（`__CUT__`）。押すと古いコメントが追加で表示される。すべて押し切るまで収集しない |
| 「コメントを入力」欄 | 開いたコメント欄の**終わり**の目印（`__END__`） |
| リアクション・コメント数の行 | ノートの時刻行の直前。画素の明るさ（RGBの合計>330）で横方向に塊に分ける。幅15〜18.5ptの塊がアイコン（😊, 💬, 共有）、それ以外が数字。**💬アイコンの後ろの数字の塊**がコメント数（無ければ0）。数字の塊は5倍に拡大し、周りに余白を付けて**同じ画像を3回横に並べて**OCRし、最初の数を採用する（1桁の数字はそのままだとVisionが読まないため） |
| コメント欄を開くボタン | 数の行の x=73。**押すたびに開く／閉じるが切り替わる**ので、押す前に開いているかどうかを判定する（ノートの次のブロックが コメント / `__CUT__` / `__END__` なら開いている） |
| スクロール | ピクセル単位のスクロールイベントは無視されるので、行単位で送る（`kCGScrollEventUnitLine`、1回あたり3行）。1行あたりの移動量は最初に測る（Retina 2倍で約33px/行） |

### コメント欄の読み取り（撮影 → つなぐ → 1回OCR）

コメント欄は、1画面ずつ読んで文字で位置合わせする方式をやめた（コメントが多いと上下に往復して破綻した）。設計と実測値は [openchat-capture-design.md](openchat-capture-design.md)。

1. コメント欄を開き、「前のコメントを見る」を押し切る（`session.py`。押す操作はこれまでどおり `safety.guard_click` を通る）。
2. ノートの見出しから、コメント入力欄まで、**スクロールだけ**で下へ撮り進める（`capture.py`）。前の画像との位置ずれは、行ごとの画素の指紋の一致だけで測る（一致率0.80以上、2番目の候補との差0.25以上でなければ、その画像は捨てて歩幅を半分にして撮り直す）。上の固定見出し・右下の＋ボタン・スクロールバーは範囲から外す。
3. つなぐときは、各行を**1つの画像からだけ**取り、切れ目は無地の行にする。文字の行の途中では切れず、同じ文が二重に写らない。
4. できた縦長画像を、1,000pt・重なり200ptのタイルに分けてVisionで読む。境目を400ptずらしてもう一度読み、同じ位置の行は、時刻として読める方（なければ信頼度の高い方）を採る（`tallocr.py`）。
5. 時刻の行（投稿の区切り）でブロックに分ける（`tallparse.py`）。時刻が読めていない投稿の直前は、その行を拡大率を変えて読み直す。数の行は画素で切って、1桁は同じ画像を並べ、拡大率を変えて多数決で読む（桁数が合わなければ「不明」）。
6. 開いた後の見出しに出ている件数と、区切ったコメントの数を照合する（§7の5）。

## 5. 同じものかどうかの判定（OCRの揺れへの対策）

OCRは画面ごとに少しずつ違う結果を返す（例: さくらもと／さくらまと、参加者A／参加者A'、本文冒頭の欠け）。そのため、読み取った文字列のハッシュ値だけで同じものかを判定しない。台帳にある既存のレコードと**照合して** ID を決める。IDは collector が発行するUUIDで、一度決まったら変えない。

### 正規化

```
norm_name(s) = 先頭の記号を除去 → 空白除去 → NFKC
norm_text(s) = NFKC → 空白・「・.…。、」を除去 → 先頭80文字
sim(a, b)    = difflib.SequenceMatcher(None, norm_text(a), norm_text(b)).ratio()
```

### ノートの照合（上から順に試し、最初に当てはまったもので確定する）

1. 作者名が一致し、日時がどちらも正確で一致する（分単位）→ 同じノート
2. 作者名が一致し、日時の差がおおよその値の誤差の範囲内（`approx_hour` なら±90分、`approx_min` なら±5分）で、かつ `sim(本文冒頭) ≥ 0.85` → 同じノート
3. 作者名が一致しなくても `sim(本文冒頭) ≥ 0.92` で、日時の誤差が範囲内 → 同じノート（作者名の揺れを吸収）
4. どれにも当てはまらない → 新しいノート

照合して同じノートと分かったら、正確な日時・長い方の本文・より確かな作者名（出てきた回数の多い方）で上書きする。

### コメントの照合（そのノートの中だけで行う）

ちきりんが**同じノートに複数回コメントする**ケースを、1つにまとめてしまわないための規則。

1. 作者名が一致し、`sim(本文) ≥ 0.85`、日時の誤差が範囲内 → 同じコメント
2. 候補が複数あるとき（例: 同じ人の「同感です」が2件）は、**表示順（ordinal、そのノートのコメントの何番目か）** がいちばん近いものを選ぶ。1回の収集で表示順が同じものが2件あれば、別のコメントとして扱う
3. どれにも当てはまらない → 新しいコメント

- 本文が違えば、同じ作者でも別のコメントになる。ちきりんの2件目・3件目も、それぞれ別に保存される。
- 1回の収集の中では、表示順が違う2件を1つにまとめない（画面をまたいだ重複の除去は、隣り合う画面の重なり部分だけで行う）。

### ちきりん判定

| 公式バッジ | 名前に「ちきりん」を含む | 扱い |
|---|---|---|
| あり | あり | 対象（`is_target=1`） |
| あり | なし | 対象。ただし名前の読み取り失敗の可能性があるので警告に記録する |
| なし | あり | **対象外**（なりすまし対策）。警告に記録する。同じコメントを別の画面でバッジありで撮れていれば対象に上書きする（1画面でもバッジが見えれば対象） |
| なし | なし | 対象外 |

## 6. 日時の扱い

- LINEの表示は**Macのその時点のタイムゾーン**。collector は `datetime.now().astimezone()` で取得時刻とタイムゾーンを記録し、D1には**UTCのISO 8601**で保存する。画面表示は日本時間（放送と対応させるため）。
- `posted_at_precision`:
  - `exact`: 「昨日 午後9:46」「一昨日 …」「9.21 午後3:47」「2025.12.3 …」（年が無い表示が未来の日付になる場合は前年とする）
  - `approx_min`: 「今」「N秒前」「N分前」
  - `approx_hour`: 「N時間前」
- 保存されている値が approx で、新しく読んだ値が exact なら上書きする（逆は上書きしない）。1〜2日後に再び一覧を見れば、ほとんどが正確な日時になる。
- 画面には approx のものに「約」を付けて表示する。

## 7. 差分取得のアルゴリズム（`sync.py`）

```
run = start_run()                       # POST /api/openchat/sync {action:"start"}
ledger = load_ledger() or restore_from_portal() or abort_unless_first_run()
to_top()                                # 先頭の変化が止まるまで上へスクロール
unchanged_streak = 0
for note_block in scan_note_list():     # 上から順に、完全なノートブロックを返す
    note = ledger.match_note(note_block)            # §5
    changed = note is None \
           or note.comment_count != note_block.comment_count \
           or note.needs_recheck \
           or (note_block.is_target and not note.body_complete)
    ledger.touch(note, note_block)       # 日時の正確化・最終確認日時の更新
    if changed:
        unchanged_streak = 0
        result = open_and_collect(note_block)       # 下記
        ledger.apply(note, result)       # コメントの照合・追加・削除検知
        uploader.queue(note)             # 20ノートごとに送信
    else:
        unchanged_streak += 1
    if not first_run and note.posted_at < now - SCAN_DAYS and unchanged_streak >= 5:
        break                            # 見直す範囲の外まで来た
    ledger.save()                        # ノート1件ごとに保存（中断に強くするため）
uploader.flush(); complete_run()
```

- `SCAN_DAYS` の初期値は21日（オプチャの対象が「過去3週間以内に放映された番組」のため）。初回実行時は全件（一覧の最後まで）を読む。
- **ローカル台帳が無く、Portalからの復元もできない場合**（設定ミスでの認証失敗など）は、`--first-run` を明示していない限りそこで中断する。黙って空の台帳から始めると、Portalに既にある内容が新しいIDで再度送られ、重複ノート・重複コメントを作ってしまうため（2026-09-25、認証設定の誤りで実際に発生し、`wrangler d1 execute` で手動復旧した）。
- 一覧の最後は「＜重要＞このオープンチャットは…」のノート（9.21 午後2:17、ちきりん投稿。検証では、ここより古いノートは見つからなかった）と想定している。これを見たら終了する。**一覧の本当の末尾かどうかは未確認**なので、実装の最初の手順で確かめる。

### `open_and_collect(note)`

1. 読むノートは、本文に「もっと見る」があれば押して全文を取る（ちきりんが関わるかは開いてから分かり、関わるノートはスレッド主の投稿を画面に出すため）。
2. コメント欄が閉じていれば、数の行の x=73 を押して開く（開いているかどうかは §4 の方法で判定する）。
3. 開いた直後は最新のコメント付近が表示されるので、上へスクロールしながら「前のコメントを見る」を押し切る。ノート本体が完全に見えて、ボタンが無くなったところで止める。
4. 見出しから `__END__`（コメント入力欄）まで、撮ってつなぎ、1回で読む（§4 「コメント欄の読み取り」）。
5. **件数の照合**: 開いた後の見出しの件数（読んでいる間に増減することがある）と、集めた件数を比べる。違えば、3に戻って1回だけやり直す。それでも違えば `needs_recheck=1` にし、そのノートの `comment_count` は更新しない（次回もまた開く）。集めた分は保存する。
6. コメント欄をもう一度押して閉じる（一覧を短く保ち、次のノートを探しやすくするため）。
7. **削除の検知**: 件数が一致したときだけ、台帳にあって今回見つからなかったコメントに `deleted_at` を入れる（件数が一致しないときは、取りこぼしと区別できないので何もしない）。

## 8. D1スキーマ

`migrations/0009_openchat.sql` を追加し、同じ内容を `db/index.ts` の `ensureSchema()` にも入れる（`docs/data-model.md` の規則どおり）。

```sql
CREATE TABLE IF NOT EXISTS openchat_notes (
  id TEXT PRIMARY KEY,                -- collectorが発行したUUID（台帳と共通）
  room TEXT NOT NULL,                 -- 'atsumare-tv'（将来、他のチャットを足せるように）
  author_name TEXT NOT NULL,
  author_is_target INTEGER NOT NULL DEFAULT 0,   -- ちきりんのノートか
  program_title TEXT NOT NULL DEFAULT '',        -- 本文の最初の1行（120文字まで）
  link_title TEXT NOT NULL DEFAULT '',           -- リンクカードの題名
  link_url TEXT NOT NULL DEFAULT '',             -- 本文中に読み取れたURL（あれば）
  body_text TEXT NOT NULL DEFAULT '',            -- ちきりんのノートは全文、それ以外は画面に見えている範囲
  body_complete INTEGER NOT NULL DEFAULT 0,      -- 「もっと見る」を開いて全文を取ったか
  posted_at TEXT NOT NULL,                       -- UTC ISO
  posted_at_precision TEXT NOT NULL,             -- exact | approx_min | approx_hour
  posted_at_raw TEXT NOT NULL DEFAULT '',
  comment_count INTEGER NOT NULL DEFAULT 0,      -- 最後に件数が一致したときのコメント数
  target_comment_count INTEGER NOT NULL DEFAULT 0, -- ちきりんのコメント数（一覧表示用に保持）
  needs_recheck INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_checked_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK(posted_at_precision IN ('exact','approx_min','approx_hour'))
);
CREATE INDEX IF NOT EXISTS openchat_notes_target_idx
  ON openchat_notes(room, posted_at DESC)
  WHERE deleted_at IS NULL AND (author_is_target = 1 OR target_comment_count > 0);

CREATE TABLE IF NOT EXISTS openchat_comments (
  id TEXT PRIMARY KEY,                -- collectorが発行したUUID
  note_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,           -- 最後に取得したときの表示順（0始まり）
  author_name TEXT NOT NULL,
  is_target INTEGER NOT NULL DEFAULT 0,
  body_text TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  posted_at_precision TEXT NOT NULL,
  posted_at_raw TEXT NOT NULL DEFAULT '',
  ocr_min_confidence REAL,            -- 行ごとのOCR信頼度の最小値（誤字の多い候補の目安）
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK(posted_at_precision IN ('exact','approx_min','approx_hour'))
);
CREATE INDEX IF NOT EXISTS openchat_comments_note_idx ON openchat_comments(note_id, ordinal);
CREATE INDEX IF NOT EXISTS openchat_comments_target_idx
  ON openchat_comments(note_id, posted_at) WHERE is_target = 1 AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS openchat_sync_runs (
  id TEXT PRIMARY KEY,
  client_run_id TEXT NOT NULL UNIQUE,
  client_version TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,               -- started | success | partial | failed | aborted
  notes_scanned INTEGER NOT NULL DEFAULT 0,
  notes_opened INTEGER NOT NULL DEFAULT 0,
  comments_new INTEGER NOT NULL DEFAULT 0,
  target_comments_new INTEGER NOT NULL DEFAULT 0,
  warnings_json TEXT NOT NULL DEFAULT '[]'
);
```

- 本文はD1に直接入れる（1件あたり数KB以下。R2は使わない）。
- 書き込み量の目安: 初回は全ノート（数十〜数百件）×コメント（1件あたり10〜20件）で数千行を1回だけ。2回目以降は、変わったノートの分だけ。

## 9. API

すべて `route()` で包み、Cloudflare Accessの保護下に置く。collector からの呼び出しは manage-asset と同じ Service Token（Keychain `manage-asset:portal-sync`）を使う。

### `POST /api/openchat/sync`

manage-asset の `/api/manage-asset/sync` と同じ start → 本体 → complete の3段階。

```jsonc
// start
{ "action": "start", "clientRunId": "2026-09-24T12:00:00+07:00-ab12", "clientVersion": "line-openchat/1", "startedAt": "2026-09-24T05:00:00Z" }   // startedAt: 読み取りを始めた時刻(UTC)。省略・不正・未来・7日超は受け取った時刻
// notes（1リクエスト20ノートまで。Workers FreeのCPU上限（10ms）に収めるため）
{ "action": "notes", "clientRunId": "...", "notes": [
  { "id": "uuid", "room": "atsumare-tv", "authorName": "ちきりん", "authorIsTarget": true,
    "programTitle": "9月23日の報道特集の真ん中あたり。…", "linkTitle": "", "linkUrl": "",
    "bodyText": "…", "bodyComplete": true,
    "postedAt": "2026-09-23T14:46:00Z", "postedAtPrecision": "exact", "postedAtRaw": "昨日 午後9:46",
    "commentCount": 7, "needsRecheck": false, "firstSeenAt": "…", "lastCheckedAt": "…", "deletedAt": null,
    "comments": [   // そのノートの全コメント（表示順）。送るのは変化のあったノートだけ
      { "id": "uuid", "ordinal": 0, "authorName": "参加者G", "isTarget": false, "bodyText": "…",
        "postedAt": "…", "postedAtPrecision": "approx_hour", "postedAtRaw": "7時間前",
        "ocrMinConfidence": 0.5, "firstSeenAt": "…", "lastSeenAt": "…", "deletedAt": null }
    ] }
] }
// complete
{ "action": "complete", "clientRunId": "...", "status": "success",
  "stats": { "notesScanned": 42, "notesOpened": 3, "commentsNew": 5, "targetCommentsNew": 1 },
  "warnings": ["note 9.21 午後2:24: 件数不一致 15/14"] }
```

- 保存は `INSERT … ON CONFLICT(id) DO UPDATE`。同じ内容を再送しても結果は変わらない（通信タイムアウト後の再送に対応するため）。
- サーバー側では `target_comment_count` を、そのノートの `is_target=1 AND deleted_at IS NULL` の件数で計算し直す。
- 秘密情報の混入チェック（manage-asset の `containsCredential`）は、送るデータの形が決まっているので不要。そのかわり文字数の上限（本文20,000字など）で切り詰める。

### `GET /api/openchat/ledger`

台帳の復元用。全ノートの `id, author_name, posted_at, posted_at_precision, body_text の先頭200字, comment_count, needs_recheck` と、全コメントの `id, note_id, ordinal, author_name, body_text の先頭200字, posted_at, posted_at_precision, is_target, deleted_at` を返す。ローカル台帳を失ったときだけ呼ぶ（D1の読み取り行数が多いため）。

### `GET /api/openchat/programs?q=&kind=all|thread|comment&page=`

画面用。ちきりんの投稿があるノートだけを、`posted_at` の新しい順に返す（1ページ10件。Watch Listと同じ件数。`page` は1始まりで、範囲外は空の一覧）。件数は絞り込み後の総数（`total`）で返す。

- `kind=thread`: ちきりんが立てたノートだけ
- `kind=comment`: ちきりんのコメントがあるノートだけ（本人が立てたノートでも、本人のコメントがあれば含む）
- `q`: 番組名（`program_title` / `link_title`）と、一覧に載るノートの本文（スレッド主の投稿）・ちきりんのコメントの部分一致

```jsonc
{ "programs": [
  { "noteId": "uuid", "programTitle": "…", "linkTitle": "…", "linkUrl": "…",
    "noteAuthor": "参加者B", "noteByTarget": false, "notePostedAt": "…", "notePrecision": "exact",
    "targetBody": null,                    // noteByTarget のときだけ本文
    "noteBody": "…",                       // スレッド主の投稿（番組の情報）。一覧に載るノートのものだけ
    "targetComments": [                    // 古い順。1件でも複数件でも同じ形
      { "id": "uuid", "bodyText": "…", "postedAt": "…", "precision": "exact" }
    ],
    "latestAt": "…", "latestPrecision": "exact",   // ちきりんの最新の投稿の日時(コメント、なければスレッド自身)
    "commentCount": 8, "lastCheckedAt": "…" }
], "total": 45, "page": 1, "pageSize": 10 }
```

ちきりん以外のコメント本文と、ちきりんが関わらないノートの本文は、このAPIでは返さない（検索の対象にもしない）。

## 10. 画面 `/chikirin`（一覧）と `/chikirin/:id`（詳細）

- ポータルのナビに「ちきりんオプチャ」を追加する（`app/portal-nav-links.tsx`）。
- Server Component が最初のページを取得し、クライアント側で検索と追加読み込みを行う（Watch List と同じ構成。`app/lib/queries/openchat.ts` をページとAPIで共有する）。
- **一覧**: Watch List と同じ表形式。1番組（1ノート）＝1行で、番組名を押すと詳細へ移る。
  - 列（短い名前）: 種別（スレッド／コメント）、放送局（人が編集する）、タイトル（1行目=番組名。編集した放送タイトルで、編集するまでは「（番組名 未設定）」。2行目=スレッドの冒頭）、スレ主、スレッド起票日時（スレッドが立てられた日時。表示は `mm.dd hh:mm`、概算は「約」。データは年つきのUTCで持つ）、最新ちきりん（ちきりんの最新の投稿日時）、コメント全体（ノート全体のコメント数）、コメントちきりん（ちきりんのコメント数）、状態（OK／要確認。要確認は、コメント件数が表示と合わず再確認待ち、または本文が途中までの可能性。理由はホバーと詳細に出る）、リンク（放送情報で編集したリンクだけ。ノートの生のリンクカードは、詳細でも編集・削除できないため出さない。表示名は、ラベルがあればそれ、なければサイト名（`www.web.nhk` は「NHK ONE」、`txbiz.tv-tokyo.co.jp/wbs` は「WBS」）かドメイン）。一覧には1件目だけを出し、2件目以降は下に「+N」のボタンで示し、押すとその行の残りのリンクが縦に並んで押せる（「閉じる」で戻る）。長い文言は列の幅で切り詰める（全文はホバーのURL）。Watch List（一覧の最後の列。リンクのURLが Watch List にも登録されていれば緑の「登録済」バッジを出し、押すと `/watch-list?q=<URL>` をそのURLで絞り込んで開く。複数の項目にあれば「登録済 2件」。URLは `#…` と `utm_*` を除いた正規化（`item_links.canonical_url`）で照合し、削除済みの項目は含めない。`GET /api/openchat/programs` の `watched` に、一覧のリンクごとの保存URLと件数を返す）。**一覧は読み取り専用**で、編集は詳細画面で行う。番組名の横の「新着」は、最後の取得で、ちきりんの投稿（スレッド・コメント）が初めて見つかった番組
  - **放送局の自動設定**: 放送局を編集していないときは、リンクから決める（NHK ONE→「NHK」、WBS→「テレ東」。`app/lib/openchat-meta.ts` の `SITES`）。一覧に出し、詳細の入力欄にも最初から入る（保存すると、その値を保存する）。編集した値があれば、それが優先。
- **編集**: 詳細画面で、放送局・その日の放送タイトル・リンク（URLと表示名、5件まで）を保存する。リンクは、未編集ならノートのリンクカードのURLが最初から入る。保存すると一覧へ戻る（開いたときの検索・絞り込み・ページに戻る。一覧の行リンクに `?q=&kind=&page=` を付けて持ち回り、詳細の「← 一覧に戻る」も保存後の遷移も同じ戻り先を使う）。詳細は、開くたびに最新を読み直す（先読みされた古い画面で、編集済みの値が消えて見えないように）。`openchat_note_meta` に保存し、collector の同期では上書きされない。放送局・放送タイトルは検索の対象になる。
  - 絞り込み: すべて／本人スレッド／コメント。キーワード検索。検索・絞り込みを変えると1ページ目に戻る。
  - ページ移動: 1ページ10件（Watch Listと同じ）。「N 件中 a–b」と、番号つきのページ移動（前へ・次へ・番号）を Watch List と同じ形で出す。総数は絞り込み後の件数。
  - 画面の上に、最後の取得（collector が読み取りを始めた時刻。送信が遅れても取得の時刻）と、新着の番組数（最後の取得で初めて見つかったちきりんの投稿がある番組。`first_seen_at` が取得開始以降）、警告の件数・内容（`openchat_sync_runs` の最新。押すと警告の一覧。警告には、投稿者・LINEの時刻表示・番組名を添える）を表示する。**日時はすべて日本時間（JST, UTC+9）**で、画面にも明記する。
- **詳細** `/chikirin/:id`: 画面の先頭に「放送情報（編集）」（放送局・番組名・番組タイトル・リンクの入力欄。保存できる）を置き、その下にスレッド主・起票日時・コメント数、リンク（放送情報で編集したリンクだけ。一覧のリンク列も同じく、編集したリンクだけを出す。ノートの生のリンクカードは、詳細でも編集・削除できないため、一覧・詳細のどちらにも出さない）、要確認の理由、スレッド主の投稿（番組の情報。ちきりんのスレッドなら「ちきりんのスレッド」）、ちきりんのコメントを古い順に全文で（各コメントに日時。本人が立てたノートへのコメントなら「本人コメント」）と続く。ノートの生の題名（`programTitle`）は画面上部には出さない。一覧に載らないノート・存在しないノートは「見つかりません」。`GET /api/openchat/programs/:id` と同じ `getProgram` を使う。
- 他の人のコメントは表示しない。

## 11. エラー処理と警告

| 状況 | 動作 |
|---|---|
| 前提条件を満たさない（§3） | 何もせず終了（exit ≠ 0）。launchdのときはログだけ残す |
| 実行中にユーザーが操作した | ノートの切れ目で中断し、`status=aborted` で complete を送る |
| 件数が合わない | 1回やり直し → `needs_recheck=1`、警告に記録 |
| 撮影で位置を測れない | その画像を捨て、歩幅を半分にして撮り直す。続けて失敗したら、そのノートは中止して `needs_recheck=1`、警告に記録 |
| バッジと名前が合わない | 警告に記録（§5） |
| 送信に失敗した | 台帳に `pending_upload` を付けて保存し、次回の開始時に先に再送する |
| 想定外の画面（区切りの判定に失敗） | そのときのスクリーンショットを `runs/<runId>/` に保存し、警告に記録する |

## 12. テスト

- **Python（collector）**: `tests/` に次を用意する。
  - `normalize_time`: 全表示形式、年跨ぎ、タイムゾーン
  - `identity`: OCRの揺れ（名前の1文字違い、本文冒頭の欠け）、同じ作者の複数コメント、同じ文面の短いコメント2件、approx から exact への更新
  - `parse`: スクリーンショットとOCR結果を記録した入力を使う。数の行の読み取り（1桁・2桁・3桁・コメント0件）、作者行の判定、`__CUT__` / `__END__`
  - 入力データには他の参加者の投稿が写っているので、`collector/data/line_openchat/fixtures/`（Git管理外）に置く。Gitで管理するテストには、文字を差し替えた合成データだけを使う。
- **Worker**: 既存の vitest に、sync API の冪等性、`target_comment_count` の再計算、programs API が他の人のコメントを返さないこと、を追加する。
- **実機確認**: 初回の全件取得のあと、ちきりんのコメントがあるノートを3件選び、画面上の件数・本文と保存内容を目で照合する。

## 13. 実装の順番（すべて完了。6.のlaunchdは未実装）

1. collector: `lineui.py` / `parse.py` を検証スクリプトから移し、§4 の残りの対策（つなぎ合わせ、重なり確認、数の行の読み取り）とテストを入れる
2. collector: `identity.py` / `ledger.py` と `sync.py` の差分取得（まずはPortalに送らず、JSONに出力するだけ）。初回の全件取得で精度を確認する
3. Worker: migration、`ensureSchema()`、sync / ledger / programs API
4. collector: `uploader.py`、送信失敗時の再送
5. 画面 `/chikirin` とナビ
6. （任意）launchd による、操作していないときだけの定期実行

## 14. 実装メモ（設計との違い・実装で決めたこと）

- **ノートウィンドウは自動で開かない**（§3）。開いていなければ終了する。
- **コメント欄は読んだあとも開いたままにする**。閉じ直すには、読んだ分だけ上へ戻る必要があり、時間が倍になるため。次のノートは開いたコメント欄の直後に見える。次回の実行で一覧の先頭から走査するとき、開いたままの欄があれば、その分のスクロールが増える。
- **画面の読み取り**は、1行が2つのOCR行に分かれる場合の結合、リンクカードの画像内の文字の除去、折り返した行の連結（右端が390pt以上の行は次の行へ続く）、段落の空行の保持（行の上端の差が24pt超）を `parse.py` で行う。
- **数の行**（リアクション数・コメント数）は、画素でアイコンと数字の塊に分け、数字の塊だけを拡大して読む。1桁の数字は同じ画像を3つ並べないとVisionが読まない。
- **画面をまたぐ重なり**は、`session.merge_sequence` が「直前までの末尾k件と、今回の先頭k件が一致するか」を最大のkから調べる。同じ人の同じ短文が続いても1件にまとめない。重ならないほど飛んだときは、半分戻して小さい歩幅でやり直す。
- **ユーザーの操作の検知**: 開始後にキーボードが押された、またはマウスが想定の位置から30pt以上動いた場合は、その場で中断する（`lineui.LineDriver.pause`）。中断してもノート1件ごとに台帳を保存しているので、次回はその続きから始まる。
- **送信は小さく分ける**: 1リクエスト10ノート・40コメントまで（Workers FreeのCPU上限のため）。1つのノートのコメントが多いときは、ノートの情報を繰り返しながらコメントを分けて送る。Worker側は最後にちきりんのコメント数を数え直す。`start` は再送されても同じ実行を返す。
- **安全**: LINEに対して行う操作は、①ウィンドウを前面へ出す（AXRaise）、②スクロール、③次の3種類のクリックだけ。コメントアイコン（数の行の2番目のアイコン。1番目のリアクション、3番目の共有は押さない）、「前のコメントを見る」、「もっと見る」。キーボードイベントは送らない。テストがソースを走査して、書き込みにつながるAPIが混ざっていないことを確かめる（`collector/tests/test_safety.py`）。
- **テスト**: collector（pytest。LINEの画面を模擬する `tests/sim.py` を使い、複数のコメント・長いスレッド・スクロールの揺れ・件数の不一致・削除・2回目の差分取得を含む）、Worker（同期API・一覧・台帳、実際のD1）、純粋なロジックとDOM（vitest）。

## 15. 既知の限界

- 文字はOCRで読むので誤字が残る（例: 「再審請求」→「再番請求」）。保存するのはOCRの結果そのもの。必要になったら、画面で本文を手で直せる機能を後から足す。
- LINEのアップデートで画面の配置や色が変わると、§4 の定数の調整が必要になる。前提条件の確認と警告で気づけるようにしておく。
- 取得の開始・日時はMacの状態に左右される（ロック中・LINE未起動のときは取れない）。
- LINEの規約上、自動操作はグレーな面がある。取得した内容は個人用のポータル内にとどめ、外部に公開しない。
