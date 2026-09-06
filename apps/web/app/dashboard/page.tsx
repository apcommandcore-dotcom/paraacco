"use client";

// 總覽(規格 3.1)—— Phase 4:KPI 卡片 + 近期動態。KPI 目前用既有的 list 端點在前端算
// (沒有專門的統計端點),資料量對內部工具來說還小,先求能動,量體大了再考慮換成後端
// 聚合查詢,見 CODE_TASK_go-live-a2-a3-phase1_20260904.md Phase 4 範圍說明。

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetch, type DocumentRow } from "@/lib/api";

interface Purchase {
  id: string;
  status: string;
  amountCents: number;
}

interface Asset {
  id: string;
  status: string;
}

interface ActivityEntry {
  id: number;
  entityType: string;
  entityId: string;
  kind: string;
  text: string;
  createdAt: string;
}

export default function DashboardPage() {
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [purchases, setPurchases] = useState<Purchase[] | null>(null);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch<{ documents: DocumentRow[] }>("/api/documents").then((d) => setDocuments(d.documents)),
      apiFetch<{ purchases: Purchase[] }>("/api/purchases").then((d) => setPurchases(d.purchases)),
      apiFetch<{ assets: Asset[] }>("/api/assets").then((d) => setAssets(d.assets)),
      apiFetch<{ activity: ActivityEntry[] }>("/api/activity?limit=20").then((d) => setActivity(d.activity)),
    ]).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const pendingReview = documents?.filter((d) => d.status === "review").length ?? null;
  const failed = documents?.filter((d) => d.status === "failed").length ?? null;
  const archived = documents?.filter((d) => d.status === "archived").length ?? null;
  const monthTotalCents = documents
    ?.filter((d) => d.amountCents != null && isThisMonth(d.createdAt))
    .reduce((sum, d) => sum + (d.amountCents ?? 0), 0);

  return (
    <AppShell>
      <div className="mb-1.5 flex items-baseline gap-2.5">
        <h1 className="m-0 text-[23px] font-extrabold tracking-tight">總覽</h1>
        <span className="font-mono text-[10px] tracking-[0.16em] text-foreground-3">OVERVIEW</span>
      </div>
      {error && <div className="mb-4 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">{error}</div>}

      {/* KPI 卡片版面比照設計稿(paraacco.dc.html / VaultLink.dc.html)的
          grid-template-columns:repeat(auto-fit,minmax(208px,1fr)) 配置——每張卡片
          標籤+標籤徽章、大數字(IBM Plex Mono)+單位、輔助說明文字三段式結構,點擊導到
          對應畫面。tag/hint 是純前端衍生自現有資料的顯示邏輯,沒有新增 API 呼叫。 */}
      <div className="mb-6 mt-5 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(208px, 1fr))" }}>
        <Kpi
          label="待覆核文件"
          value={pendingReview}
          unit="份"
          tag={pendingReview !== null && pendingReview > 0 ? { text: "待處理", variant: "warning" } : { text: "已清空", variant: "success" }}
          hint="點擊前往待覆核工作台"
          href="/review"
        />
        <Kpi
          label="失敗文件"
          value={failed}
          unit="份"
          tag={failed !== null && failed > 0 ? { text: "需注意", variant: "destructive" } : { text: "正常", variant: "success" }}
          hint="pipeline 處理失敗的文件"
          href="/documents?status=failed"
        />
        <Kpi label="已歸檔文件" value={archived} unit="份" tag={{ text: "累計", variant: "default" }} hint="已完成覆核並歸檔" href="/documents?status=archived" />
        <Kpi label="採購案總數" value={purchases?.length ?? null} unit="案" tag={{ text: "累計", variant: "default" }} hint="所有已建立的採購案" href="/documents?view=purchase" />
        <Kpi label="資產總數" value={assets?.length ?? null} unit="項" tag={{ text: "累計", variant: "default" }} hint="所有已登記的資產" href="/documents?view=asset" />
        <Kpi
          label="本月單據金額"
          value={monthTotalCents != null ? `NT$${(monthTotalCents / 100).toLocaleString()}` : null}
          unit=""
          tag={{ text: "本月", variant: "info" }}
          hint="依文件建立日期加總"
          href="/reports"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>近期動態</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {activity === null && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
          {activity?.length === 0 && <div className="p-4 text-sm text-muted-foreground">沒有動態紀錄。</div>}
          <ul>
            {activity?.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between border-b border-line-2 p-3 text-sm last:border-0">
                <span>{entry.text}</span>
                <span className="font-mono text-xs text-muted-foreground">{new Date(entry.createdAt).toLocaleString("zh-TW")}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </AppShell>
  );
}

function Kpi({
  label,
  value,
  unit,
  tag,
  hint,
  href,
}: {
  label: string;
  value: number | string | null;
  unit: string;
  tag: { text: string; variant: BadgeProps["variant"] };
  hint: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="flex flex-col gap-2 border border-line bg-card p-3.5 no-underline hover:border-border"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-foreground-2">{label}</span>
        <Badge variant={tag.variant}>{tag.text}</Badge>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[26px] font-bold tracking-tight text-foreground">{value ?? "…"}</span>
        {unit && <span className="text-xs text-foreground-3">{unit}</span>}
      </div>
      <div className="text-[11.5px] text-foreground-3">{hint}</div>
    </Link>
  );
}

function isThisMonth(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}
