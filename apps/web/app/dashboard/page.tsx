"use client";

// 總覽(規格 3.1)—— Phase 4:KPI 卡片 + 近期動態。KPI 目前用既有的 list 端點在前端算
// (沒有專門的統計端點),資料量對內部工具來說還小,先求能動,量體大了再考慮換成後端
// 聚合查詢,見 CODE_TASK_go-live-a2-a3-phase1_20260904.md Phase 4 範圍說明。

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
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
      <h1 className="mb-6 text-xl font-semibold tracking-wide">總覽</h1>
      {error && <div className="mb-4 border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="待覆核文件" value={pendingReview} />
        <Kpi label="失敗文件" value={failed} />
        <Kpi label="已歸檔文件" value={archived} />
        <Kpi label="採購案總數" value={purchases?.length ?? null} />
        <Kpi label="資產總數" value={assets?.length ?? null} />
        <Kpi label="本月單據金額" value={monthTotalCents != null ? `NT$${(monthTotalCents / 100).toLocaleString()}` : null} />
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
              <li key={entry.id} className="flex items-center justify-between border-b border-border p-3 text-sm last:border-0">
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

function Kpi({ label, value }: { label: string; value: number | string | null }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1 font-mono text-2xl">{value ?? "…"}</div>
      </CardContent>
    </Card>
  );
}

function isThisMonth(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}
