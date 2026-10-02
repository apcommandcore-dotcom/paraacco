"use client";

// 總覽頂部 KPI(2026-09-26,Theo:「總覽和清單功能重複,保留總覽就好」)—— 原本 /dashboard
// 的 KPI 卡片 + 多個 widget,跟 /documents 清單內容重疊。合併後「總覽」= 這一排精簡 KPI +
// 下方文件清單(documents/page.tsx),/dashboard 改成轉址到 /documents。
// 本月金額依「發票/帳單日期」(invoiceDate,沒有才用 docDate)算,不是匯入日期。

import { useEffect, useState } from "react";
import Link from "next/link";
import { useScope } from "@/components/scope-context";
import { apiFetch, type DocumentRow, type WarrantyItem } from "@/lib/api";
import { formatCents } from "@/lib/format";

function thisMonthPrefix(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function OverviewKpis() {
  const { scope } = useScope();
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  const [bills, setBills] = useState<WarrantyItem[] | null>(null);

  useEffect(() => {
    const q = scope ? `?ownership=${scope}` : "";
    setDocs(null);
    setBills(null);
    apiFetch<{ documents: DocumentRow[] }>(`/api/documents${q}`)
      .then((d) => setDocs(d.documents))
      .catch(() => setDocs([]));
    apiFetch<{ items: WarrantyItem[] }>(`/api/warranty${q}`)
      .then((d) => setBills(d.items))
      .catch(() => setBills([]));
  }, [scope]);

  const month = thisMonthPrefix();
  const pending = docs?.filter((d) => d.status === "review").length;
  const failed = docs?.filter((d) => d.status === "failed").length;
  const monthCents = docs
    ?.filter((d) => (d.invoiceDate ?? d.docDate ?? "").startsWith(month) && d.amountCents != null && d.status !== "dup")
    .reduce((s, d) => s + (d.amountCents ?? 0), 0);
  const dueBills = bills?.filter((b) => b.status !== "active").length;

  const items: { label: string; value: string | undefined; hint: string; href: string; alert?: boolean }[] = [
    { label: "待覆核", value: pending?.toString(), hint: "份,點擊前往覆核", href: "/review", alert: !!pending },
    { label: "處理失敗", value: failed?.toString(), hint: "份", href: "/documents?status=failed", alert: !!failed },
    {
      label: `本月單據金額(${Number(month.slice(5))} 月)`,
      value: monthCents != null ? formatCents(monthCents, { round: true }) : undefined,
      hint: "依發票/帳單日期,點擊看月報表",
      href: `/reports?month=${month}`,
    },
    { label: "即將到期/逾期", value: dueBills?.toString(), hint: "筆保固、訂閱、定期繳費", href: "/warranty", alert: !!dueBills },
  ];

  return (
    <div className="mb-5 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
      {items.map((it) => (
        <Link key={it.label} href={it.href} className="border border-line bg-surface px-4 py-3 no-underline hover:border-border">
          <div className="text-xs text-foreground-3">{it.label}</div>
          <div className={`mt-1 font-mono text-xl font-bold ${it.alert ? "text-destructive" : "text-foreground"}`}>{it.value ?? "…"}</div>
          <div className="text-[11px] text-foreground-3">{it.hint}</div>
        </Link>
      ))}
    </div>
  );
}
