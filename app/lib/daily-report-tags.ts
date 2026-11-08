/** 作業日報のタグ付け。取り込み時に一度だけ付けてD1へ保存し、表示時には計算しない
 *  (docs/daily-report-ingest-design.md §3.4)。D1には触れない純粋なロジック。
 *
 *  辞書を変えたら app/lib/daily-report-parse.ts の PARSER_VERSION を上げる(再解析で全件に反映される)。
 *  このリポジトリは公開なので、辞書には個人の口座・取引先・地名のような固有名詞を入れず、一般的な語で当てる。 */

import type { ParsedDailyReport } from "./daily-report-parse.ts";

export type TagGroup = "study" | "dev" | "money" | "life" | "media";

export type TagDefinition = {
  key: string;
  label: string;
  group: TagGroup;
  pattern: RegExp;
  /** 他のタグがどれも当たらなかったときだけ付ける(「開発」のように、具体的なプロジェクト名と一緒に出がちな語) */
  generic?: boolean;
};

/** どのタグにも当たらなかった時間・作業項目をまとめるキー */
export const OTHER_TAG = "other";

export const DAILY_REPORT_TAGS: TagDefinition[] = [
  { key: "english", label: "英語学習", group: "study", pattern: /英語|英単語|英作文|英文|英会話|構文|語法|語彙|文法|関係詞|Anki|シャドーイング|リスニング|TOEIC|IELTS|発音/ },
  { key: "robotics", label: "ROS 2・ロボティクス", group: "study", pattern: /ROS ?2|ros2|Nav2|SLAM|Gazebo|ロボット|ロボティクス|robotics/ },
  { key: "electronics", label: "電子工作・電気", group: "study", pattern: /電気工事士|Arduino|Tinkercad|SunFounder|電子工作|回路|オームの法則|キルヒホッフ|マルチメーター|電圧|電流|電力/ },
  { key: "cs", label: "コンピュータ科学", group: "study", pattern: /コンピュータ科学|情報理論|インターネットの仕組み|プログラミングパラダイム|パラダイム・シフト|アルゴリズム|データ構造|AtCoder|LeetCode/ },

  { key: "dashboard", label: "dashboard", group: "dev", pattern: /dashboard|ダッシュボード|watch[- ]list|ちきりんオプチャ|オプチャ|collector/i },
  { key: "texttube", label: "TextTube", group: "dev", pattern: /TextTube|text-tube/i },
  { key: "manage_asset", label: "manage-asset", group: "dev", pattern: /manage[- ]asset/i },
  { key: "scraping", label: "スクレイピング", group: "dev", pattern: /scrap|スクレイピング|twitter-html-extractor|Xデータ抽出|bing検索スクリプト/i },
  { key: "gym_app", label: "ジムアプリ", group: "dev", pattern: /gym-app|GymLog|workout-log|ジムアプリ/i },
  { key: "daily_report", label: "日報ツール", group: "dev", pattern: /auto-daily-report|Auto Daily Report|日報ツール|日報生成|日報作成/i },
  { key: "mulmo", label: "Mulmo", group: "dev", pattern: /Mulmo/i },
  { key: "ai", label: "AI・LLM", group: "dev", pattern: /(?<![A-Za-z])AI(?![A-Za-z])|Claude(?! ?Code)|claude\.ai|ChatGPT|Perplexity|LLM|Anthropic|エージェント|NotebookLM|Antigravity/ },
  { key: "pc", label: "PC・環境整備", group: "dev", pattern: /Ghostty|Raycast|Homebrew|VPN|ディスク容量|Bitwarden|パスワード管理|Wi-?Fi|ファイルの整理|ブラウザ履歴|ブラウザ設定|WezTerm/ },
  { key: "dev", label: "開発（その他）", group: "dev", generic: true, pattern: /開発|実装|改修|リファクタ|デプロイ|GitHub|Pull Request|Claude ?Code|Cloudflare|Supabase|Next\.js|Xcode|Simulator|wrangler|スクリプト|main\.py|\.(?:py|js|ts|tsx|html)(?![A-Za-z])/ },

  { key: "money", label: "資産・お金", group: "money", pattern: /資産|投資|NISA|株|証券|銀行|口座|送金|両替|暗号資産|仮想通貨|ウォレット|取引所|確定申告|税|法人化|家計|為替|ポートフォリオ|DeFi|エアドロップ|マイニング|金融|資金|残高|本人確認|KYC|クレジットカード|イーサリアム|ビットコイン/ },

  { key: "travel", label: "旅行・住まい", group: "life", pattern: /物件|賃貸|コンド|移住|ビザ|航空券|フライト|旅行|ホテル|帰省|空港|旅程|渡航|在留|宿泊|新幹線|切符|ノマド|運転免許/ },
  { key: "shopping", label: "買い物", group: "life", pattern: /買い物|購入|Amazon|Shopee|Lazada|IKEA|メルカリ|商品|返品|通販|ECサイト|セール/ },
  { key: "notes", label: "メモ・習慣", group: "life", pattern: /モーニングページ|Obsidian|Notion|メモ|日記|習慣|ルーティン|読書/ },
  { key: "communication", label: "連絡・SNS", group: "life", pattern: /LINE|Discord|Gmail|メール|メルマガ|Slack|SNS|(?<![A-Za-z])X(?=[・と閲で確の])/ },

  { key: "media", label: "動画・番組視聴", group: "media", pattern: /動画|視聴|YouTube|NHK|TVer|ニュース|番組|ドキュメンタリー|バラエティ|WBS|ガイアの夜明け|映像の世紀|漫画|マンガ|ヤンマガ|Voicy|ポッドキャスト|Netflix|音楽|ブログ|記事|攻略|ゲーム/ },
];

/** 見ていたことを表す語。この語を含む節は、見た物の話題(旅行・コンピュータ科学など)ではなく「視聴」だけに数える。 */
const VIEWING = /視聴|鑑賞/;
const MEDIA_TAG = "media";

/** 節の終わりと見なす語(「〜の確認」「〜を視聴」のような動作)。 */
const CLAUSE_END = /(?:確認|視聴|鑑賞|閲覧|再生|学習|勉強|復習|練習|利用|使用|修正|改修|実装|開発|作成|調査|検索|整理|設定|対応|追加|削除|更新|作業|購入|入力|読書|操作|変更|準備|編集|登録|比較|検討|導入|続き|相談|質問|執筆|記入|計画|レビュー)$/;
/** 見る物そのものを表す語。これを含む区切りは、後ろの「〜を視聴」の目的語としてつなぐ。 */
const CONTENT = /動画|番組|ラジオ|配信|チャンネル|講座|対談|セミナー|アーカイブ|VLOG|特集|#\d/i;
const TRAILING_NOTE = /\s*[（(][^（）()]*[）)]\s*$/;

/** 区切りの後ろで節を終えるか。動作の語で終わるとき、または「、」の前が(見る物の語が無く)視聴以外のタグに当たるとき
 *  (「Voicy、Perplexity、YouTube視聴」の Perplexity は見た物ではなく使った物)。
 *  「と」は「AIと市場の動画」のように題名の中にも出るので、動作の語で終わるときだけ区切る。 */
function endsClause(current: string, piece: string): boolean {
  const core = current.replace(/[、,，と]$/, "").replace(TRAILING_NOTE, "").trim();
  if (CLAUSE_END.test(core)) return true;
  if (piece.endsWith("と") || CONTENT.test(piece)) return false;
  return DAILY_REPORT_TAGS.some((tag) => !tag.generic && tag.key !== MEDIA_TAG && tag.pattern.test(piece));
}

/** 文を「、」「と」で区切り、節にまとめる。節の終わりでない区切りは次の区切りとつなぐ
 *  (「韓国旅行の動画、ゆるコンピュータ科学ラジオを視聴」は全体で1つの節、「英作文の続き、報道1930の視聴」は2つの節)。 */
function splitClauses(text: string): string[] {
  const clauses: string[] = [];
  let current = "";
  for (const piece of text.split(/(?<=[、,，と])/)) {
    current += piece;
    if (endsClause(current, piece)) {
      clauses.push(current);
      current = "";
    }
  }
  if (current) clauses.push(current);
  return clauses;
}

/** 文に当たるタグのキー(辞書の順)。具体的なタグが無いときだけ generic なタグを見る。
 *  視聴の節(VIEWING)は「視聴」だけに数え、ほかのタグはそれ以外の節から当てる。 */
export function tagsForText(text: string): string[] {
  const clauses = splitClauses(text);
  const viewing = clauses.some((clause) => VIEWING.test(clause));
  const rest = clauses.filter((clause) => !VIEWING.test(clause)).join("");
  const specific = DAILY_REPORT_TAGS
    .filter((tag) => !tag.generic && ((viewing && tag.key === MEDIA_TAG) || tag.pattern.test(rest)))
    .map((tag) => tag.key);
  if (specific.length) return specific;
  return DAILY_REPORT_TAGS.filter((tag) => tag.generic && tag.pattern.test(rest)).map((tag) => tag.key);
}

export type ItemTag = { source: "work" | "time"; position: number; tag: string };
export type TagDay = { tag: string; minutes: number; workItemCount: number };

/** 1日分の作業項目と時間帯にタグを付け、1日×タグの合計(daily_report_tag_days の行)も作る。
 *  - 作業項目は箇条書きの文で当て、当たらなければ見出し(### の分類名)で当てる。
 *  - 時間は時間帯の表から数え、複数のタグが付いた時間帯は所要時間をタグの数で等分する
 *    (1日の合計が「記録時間−欠落時間」を超えないように)。端数の分は先頭のタグに寄せる。
 *  - どのタグにも当たらない項目・時間は OTHER_TAG に数え、明細(ItemTag)は作らない。
 *  - 「ログなし」の時間帯は数えない(daily_reports.gap_minutes に別で入る)。 */
export function tagDailyReport(report: Pick<ParsedDailyReport, "workItems" | "timeBlocks">): { itemTags: ItemTag[]; tagDays: TagDay[] } {
  const itemTags: ItemTag[] = [];
  const days = new Map<string, TagDay>();
  const day = (tag: string) => {
    let row = days.get(tag);
    if (!row) days.set(tag, (row = { tag, minutes: 0, workItemCount: 0 }));
    return row;
  };

  for (const item of report.workItems) {
    const own = tagsForText(item.text);
    const tags = own.length ? own : tagsForText(item.category);
    for (const tag of tags) itemTags.push({ source: "work", position: item.position, tag });
    for (const tag of tags.length ? tags : [OTHER_TAG]) day(tag).workItemCount += 1;
  }

  for (const block of report.timeBlocks) {
    if (block.isGap) continue;
    const tags = tagsForText(block.activity);
    for (const tag of tags) itemTags.push({ source: "time", position: block.position, tag });
    const minutes = block.durationMinutes ?? 0;
    const targets = tags.length ? tags : [OTHER_TAG];
    const share = Math.floor(minutes / targets.length);
    targets.forEach((tag, index) => {
      day(tag).minutes += share + (index === 0 ? minutes - share * targets.length : 0);
    });
  }

  return { itemTags, tagDays: [...days.values()] };
}
