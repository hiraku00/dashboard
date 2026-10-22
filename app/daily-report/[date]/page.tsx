import { redirect } from "next/navigation";
import { isReportDateString } from "@/app/lib/daily-report-summary";

// 第1版(#248)の「1日の詳細」のURL。リンクを壊さないよう、日次の表示へ移す。
export default async function DailyReportDayRedirect({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  redirect(isReportDateString(date) ? `/daily-report?range=day&date=${date}` : "/daily-report");
}
