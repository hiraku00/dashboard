import { PortalHeader } from "../portal-nav";
import { DailyReportApp } from "../daily-report-app";
import { REPORT_TABS, type ReportTab } from "../daily-report-ui";
import { listReportDates, periodView } from "@/app/lib/queries/daily-report";
import { buildModel, type DailyReportModel } from "@/app/lib/daily-report-model";
import { defaultAnchor, isRange, isReportDateString, periodRange, type Range } from "@/app/lib/daily-report-summary";
import { todoDate } from "@/app/lib/todo-date";

type Params = { range?: string | string[]; date?: string | string[]; tab?: string | string[] };
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// Server Component: 期間(?range=&date=)の分を D1 から1回の batch で読み(app/lib/queries/daily-report.ts)、
// 画面の形に組み立てて(app/lib/daily-report-model.ts)クライアントのワークスペースへ渡す。
// range が無ければ日次。date が無ければ既定の期間(日次は最新の日報の日、週次・月次は今の期間に日報があればそこ、無ければ最新の日報の期間)を開く。
export default async function DailyReportPage({ searchParams }: { searchParams?: Promise<Params> }) {
  const params = (await searchParams) ?? {};
  const rawRange = first(params.range);
  const range: Range = isRange(rawRange) ? rawRange : "day";
  const rawTab = first(params.tab);
  const tab: ReportTab = REPORT_TABS.some(([id]) => id === rawTab) ? (rawTab as ReportTab) : "summary";
  const rawDate = first(params.date);
  const today = todoDate();

  let model: DailyReportModel | null = null;
  try {
    const date = rawDate && isReportDateString(rawDate) ? rawDate : defaultAnchor(range, await listReportDates(), today);
    const period = periodRange(range, date, today);
    model = buildModel(await periodView(period), period, today);
  } catch {
    model = null;
  }

  if (!model) {
    return (
      <main className="portal-shell asset-workspace daily-report-workspace">
        <PortalHeader title="作業日報" active="/daily-report" />
        <section className="asset-panel dr-panel"><p className="dr-empty">日報を読み込めませんでした。時間をおいて開き直してください。</p></section>
      </main>
    );
  }
  // 期間が変わるたびに状態(開いているタブ以外)を作り直す
  return <DailyReportApp key={`${model.period.range}-${model.period.anchor}`} model={model} initialTab={tab} />;
}
