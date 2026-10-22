import { redirect } from "next/navigation";
import { PortalHeader } from "../portal-nav";
import { latestReportDate } from "@/app/lib/queries/daily-report";

// 週・月のダッシュボードができるまでの入口: 最新の日報の「1日の詳細」へ移る
// (docs/daily-report-view-design.md §10 の段階4で、この場所がダッシュボードになる)。
export default async function DailyReportIndexPage() {
  let latest: string | null = null;
  let failed = false;
  try {
    latest = await latestReportDate();
  } catch {
    failed = true;
  }
  if (latest) redirect(`/daily-report/${latest}`);
  return (
    <main className="portal-shell">
      <PortalHeader title="作業日報" active="/daily-report" />
      <section className="tube-panel dr-card">
        <p className="dr-empty">{failed ? "日報を読み込めませんでした。時間をおいて開き直してください。" : "取り込み済みの日報がありません。"}</p>
      </section>
    </main>
  );
}
