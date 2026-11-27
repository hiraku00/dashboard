import { PortalHeader } from "../portal-nav";
import { MorningPageApp } from "../morning-page-app";
import { MORNING_TABS, buildMorningModel, isMorningRange, type MorningPageModel, type MorningRange, type MorningTab } from "@/app/lib/morning-page-model";
import { isMonth, isYear, morningPageView } from "@/app/lib/queries/morning-page";
import { todoDate } from "@/app/lib/todo-date";

type Params = { range?: string | string[]; date?: string | string[]; tab?: string | string[]; q?: string | string[]; month?: string | string[]; year?: string | string[] };
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
/** 前の作りのタブ名で来たら: 推移は全期間の概要、月(と、その前の概要・日ごと)は月次の概要、気がかりは内容 */
const LEGACY_TABS: Record<string, MorningTab> = { trend: "summary", month: "summary", overview: "summary", days: "summary", notes: "content" };

/** URL(?range=month|year|all&date=YYYY-MM|YYYY&tab=summary|content|place&q=)から、期間とタブを決める。
 *  前の作りの ?month=YYYY-MM(月を開く)・?year=YYYY(気がかりの年)・?tab=trend(全期間の推移)も読み替える */
function resolve(params: Params): { range: MorningRange; anchor: string | null; tab: MorningTab } {
  const rawTab = first(params.tab) ?? "";
  const rawRange = first(params.range);
  const date = first(params.date);
  const legacyMonth = first(params.month);
  const legacyYear = first(params.year);
  const tab: MorningTab = MORNING_TABS.some(([id]) => id === rawTab) ? (rawTab as MorningTab) : (LEGACY_TABS[rawTab] ?? "summary");
  if (isMorningRange(rawRange)) {
    if (rawRange === "month") return { range: "month", anchor: isMonth(date) ? date : null, tab };
    if (rawRange === "year") return { range: "year", anchor: isMonth(date) ? date.slice(0, 4) : isYear(date) ? date : null, tab };
    return { range: "all", anchor: null, tab };
  }
  if (isMonth(date)) return { range: "month", anchor: date, tab };
  if (isYear(date)) return { range: "year", anchor: date, tab };
  if (rawTab === "notes" && isYear(legacyYear)) return { range: "year", anchor: legacyYear, tab };
  if (isMonth(legacyMonth)) return { range: "month", anchor: legacyMonth, tab };
  if (rawTab === "trend") return { range: "all", anchor: null, tab };
  return { range: "month", anchor: null, tab };
}

// Server Component: 期間(月次・年次・全期間)の分を D1 から1回の batch で読み(app/lib/queries/morning-page.ts)、
// 画面の形に組み立てて(app/lib/morning-page-model.ts)クライアントへ渡す。開いたときは月次・データのある最新の月。
export default async function MorningPage({ searchParams }: { searchParams?: Promise<Params> }) {
  const params = (await searchParams) ?? {};
  const { range, anchor, tab } = resolve(params);
  const q = (first(params.q) ?? "").slice(0, 100);

  let model: MorningPageModel | null = null;
  try {
    const view = await morningPageView({ range, anchor }, q);
    model = buildMorningModel(view, { range, anchor }, todoDate());
  } catch {
    model = null;
  }

  if (!model) {
    return (
      <main className="portal-shell asset-workspace daily-report-workspace">
        <PortalHeader title="モーニングページ" active="/morning-page" />
        <section className="asset-panel dr-panel"><p className="dr-empty">モーニングページを読み込めませんでした。時間をおいて開き直してください。</p></section>
      </main>
    );
  }
  // 期間が変わるたびに状態(開いているタブ以外)を作り直す
  return <MorningPageApp key={`${model.range}-${model.anchor}-${q}`} model={model} initialTab={q ? "content" : tab} />;
}
