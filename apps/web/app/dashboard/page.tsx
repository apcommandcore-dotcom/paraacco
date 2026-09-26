// 2026-09-26:總覽與清單合併(Theo:「總覽和清單功能重複,保留總覽就好」)——「總覽」改為
// /documents(頂部精簡 KPI + 文件清單),這個舊路由只做轉址,舊書籤與站內連結仍然可用。
// 合併前的 KPI/widget 版本見 git 歷史(commit 16de76b 之前的 apps/web/app/dashboard/page.tsx)。
import { redirect } from "next/navigation";

export default function DashboardPage() {
  redirect("/documents");
}
