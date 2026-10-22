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

/** 文に当たるタグのキー(辞書の順)。具体的なタグが無いときだけ generic なタグを見る。 */
export function tagsForText(text: string): string[] {
  const specific = DAILY_REPORT_TAGS.filter((tag) => !tag.generic && tag.pattern.test(text)).map((tag) => tag.key);
  if (specific.length) return specific;
  return DAILY_REPORT_TAGS.filter((tag) => tag.generic && tag.pattern.test(text)).map((tag) => tag.key);
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
