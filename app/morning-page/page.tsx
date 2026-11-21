import { PortalHeader } from "../portal-nav";
import { MorningPageApp, type MorningTab } from "../morning-page-app";
import { buildMorningModel, type MorningPageModel } from "@/app/lib/morning-page-model";
import { isMonth, morningPageView } from "@/app/lib/queries/morning-page";

type Params = { month?: string | string[]; tab?: string | string[]; q?: string | string[] };
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const TABS: MorningTab[] = ["overview", "days", "notes"];

// Server Component: 開く月(?month=YYYY-MM、無ければデータのある最新の月)の分を D1 から1回の batch で読み
// (app/lib/queries/morning-page.ts)、画面の形に組み立てて(app/lib/morning-page-model.ts)クライアントへ渡す。
export default async function MorningPage({ searchParams }: { searchParams?: Promise<Params> }) {
  const params = (await searchParams) ?? {};
  const rawMonth = first(params.month);
  const rawTab = first(params.tab);
  const tab: MorningTab = TABS.includes(rawTab as MorningTab) ? (rawTab as MorningTab) : "overview";
  const q = (first(params.q) ?? "").slice(0, 100);

  let model: MorningPageModel | null = null;
  try {
    model = buildMorningModel(await morningPageView(isMonth(rawMonth) ? rawMonth : null, q));
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
  // 月が変わるたびに状態(開いているタブ以外)を作り直す
  return <MorningPageApp key={`${model.month}-${q}`} model={model} initialTab={q ? "notes" : tab} />;
}
