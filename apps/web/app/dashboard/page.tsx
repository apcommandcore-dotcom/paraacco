"use client";

// 總覽(規格 3.1)—— KPI 卡片 + 近期動態(既有)+ 2026-09-07 補完設計落差任務書新增的
// 三個 widget:待處理事項(任務 4)、本週新匯入文件、本月摘要(任務 1)、即將到期的保固與
// 訂閱(任務 3)。KPI/widget 都用既有的 list 端點在前端算,沒有新增聚合端點,量體大了再考慮
// 換後端聚合查詢(沿用上一輪就定案的做法)。

import { useEffect, useState } from "react";
import Link from "next/link";
import { daysUntil, daysUntilEndOfWeek, isBeforeThisWeek, isThisWeek } from "@paraacco/domain";
import { AppShell } from "@/components/app-shell";
import { useScope } from "@/components/scope-context";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  apiFetch,
  OWNERSHIP_LABELS,
  RECONCILIATION_STATUS_LABELS,
  type DocumentRow,
  type EntityRow,
  type OwnershipScope,
  type ProjectRow,
  type PurchaseRow,
  type StatementLineRow,
  type WarrantyItem,
} from "@/lib/api";

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
  const { scope, setScope } = useScope();
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [purchases, setPurchases] = useState<PurchaseRow[] | null>(null);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [warranty, setWarranty] = useState<WarrantyItem[] | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [statementLines, setStatementLines] = useState<StatementLineRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // entity/project 篩選(2026-09-13 財務文件自動分類新增,架構文件第 6 節「總覽三分頁」)——
  // 跟上面的 ownership scope(既有的範圍切換器,corp/per/advance/custody)是正交的兩個維度,
  // entityId 只在 scope==='corp' 時有意義(平行空間/事務所都是公司範疇底下的法律主體),
  // projectId 則不管 scope 是什麼都可以獨立篩選(專案支出可能是任何 ownership)。
  const [entityId, setEntityId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ entities: EntityRow[] }>("/api/entities")
      .then((d) => setEntities(d.entities))
      .catch(() => {});
    apiFetch<{ projects: ProjectRow[] }>("/api/projects")
      .then((d) => setProjects(d.projects))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const q = scope ? `?ownership=${scope}` : "";
    const statementQ = entityId ? `?entityId=${entityId}` : "";
    setDocuments(null);
    setPurchases(null);
    setAssets(null);
    setWarranty(null);
    setStatementLines(null);
    Promise.all([
      apiFetch<{ documents: DocumentRow[] }>(`/api/documents${q}`).then((d) => setDocuments(d.documents)),
      apiFetch<{ purchases: PurchaseRow[] }>(`/api/purchases${q}`).then((d) => setPurchases(d.purchases)),
      apiFetch<{ assets: Asset[] }>(`/api/assets${q}`).then((d) => setAssets(d.assets)),
      apiFetch<{ items: WarrantyItem[] }>(`/api/warranty${q}`).then((d) => setWarranty(d.items)),
      apiFetch<{ activity: ActivityEntry[] }>("/api/activity?limit=20").then((d) => setActivity(d.activity)),
      apiFetch<{ statementLines: StatementLineRow[] }>(`/api/statement-lines${statementQ}`).then((d) => setStatementLines(d.statementLines)),
    ]).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [scope, entityId]);

  // entity/project 篩選只套用在 purchases(唯一有這兩個欄位的實體)——documents/assets 沒有
  // entity_id/project_id 直欄(見 packages/db/src/schema.ts entities 註解:目前只有 purchases
  // 有這個維度),所以只有「採購案總數」這個 KPI 會隨 entity/project 篩選變動,其餘 KPI
  // 維持只依 ownership 篩選,這是資料模型的真實反映,不是漏做。
  const filteredPurchases = purchases?.filter((p) => (!entityId || p.entityId === entityId) && (!projectId || p.projectId === projectId));

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

      <ScopeTabs
        scope={scope}
        setScope={setScope}
        entityId={entityId}
        setEntityId={setEntityId}
        projectId={projectId}
        setProjectId={setProjectId}
        entities={entities}
        projects={projects}
      />

      {error && <div className="mb-4 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">{error}</div>}

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
        <Kpi
          label="採購案總數"
          value={filteredPurchases?.length ?? null}
          unit="案"
          tag={{ text: "累計", variant: "default" }}
          hint={entityId || projectId ? "依目前篩選條件" : "所有已建立的採購案"}
          href="/purchases"
        />
        <Kpi label="資產總數" value={assets?.length ?? null} unit="項" tag={{ text: "累計", variant: "default" }} hint="所有已登記的資產" href="/assets" />
        <Kpi
          label="本月單據金額"
          value={monthTotalCents != null ? `NT$${(monthTotalCents / 100).toLocaleString()}` : null}
          unit=""
          tag={{ text: "本月", variant: "info" }}
          hint="依文件建立日期加總"
          href="/reports"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <ReconciliationSummaryWidget lines={statementLines} />
          <TodoWidget documents={documents} warranty={warranty} />
          <WarrantyWidget warranty={warranty} />
        </div>
        <div className="flex flex-col gap-4">
          <WeeklyImportsWidget documents={documents} />
          <MonthSummaryWidget documents={documents} />
        </div>
      </div>

      <Card className="mt-4">
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

// 總覽三分頁(架構文件第 6 節)—— 全部/公司/家庭個人直接沿用既有的範圍切換器(ownership
// scope,corp/per),不是新概念;「公司」選中時額外顯示 entity 篩選 chip(平行空間/事務所),
// 「專案」是獨立的額外篩選(不是 ownership 的合法值,任何 ownership 底下的採購案都可能掛
// 專案),用一個下拉選單,不強制跟前三個分頁互斥——可以同時選「公司」+ 某個專案。
function ScopeTabs({
  scope,
  setScope,
  entityId,
  setEntityId,
  projectId,
  setProjectId,
  entities,
  projects,
}: {
  scope: OwnershipScope | null;
  setScope: (s: OwnershipScope | null) => void;
  entityId: string | null;
  setEntityId: (v: string | null) => void;
  projectId: string | null;
  setProjectId: (v: string | null) => void;
  entities: EntityRow[];
  projects: ProjectRow[];
}) {
  const tabs: { value: OwnershipScope | null; label: string }[] = [
    { value: null, label: "全部" },
    { value: "corp", label: "公司" },
    { value: "per", label: "家庭個人" },
  ];

  return (
    <div className="mb-1 flex flex-wrap items-center gap-3">
      <div className="flex border border-line">
        {tabs.map((tab) => (
          <button
            key={tab.label}
            type="button"
            onClick={() => {
              setScope(tab.value);
              if (tab.value !== "corp") setEntityId(null);
            }}
            className={`border-r border-line px-3 py-1.5 text-xs last:border-r-0 ${
              scope === tab.value ? "bg-brand font-semibold text-on-brand" : "bg-surface text-foreground hover:bg-nav-sub"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {scope === "corp" && entities.length > 0 && (
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-foreground-3">法律主體:</span>
          <button
            type="button"
            onClick={() => setEntityId(null)}
            className={`border px-2 py-1 text-[11px] ${entityId === null ? "border-brand bg-brand text-on-brand" : "border-line bg-surface text-foreground-2 hover:bg-nav-sub"}`}
          >
            全部
          </button>
          {entities.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => setEntityId(e.id)}
              className={`border px-2 py-1 text-[11px] ${entityId === e.id ? "border-brand bg-brand text-on-brand" : "border-line bg-surface text-foreground-2 hover:bg-nav-sub"}`}
            >
              {e.name}
            </button>
          ))}
        </div>
      )}

      {projects.length > 0 && (
        <select
          value={projectId ?? ""}
          onChange={(e) => setProjectId(e.target.value || null)}
          className="h-[26px] border border-line bg-surface px-2 text-xs text-foreground"
        >
          <option value="">全部專案</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

// 勾稽狀態摘要(架構文件第 6 節「總覽三分頁」要求的三個指標之一)—— 依 entityId 篩選(對應
// 上面 ScopeTabs 選的法律主體),點擊前往對帳頁看細節。
function ReconciliationSummaryWidget({ lines }: { lines: StatementLineRow[] | null }) {
  if (lines === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>勾稽狀態摘要</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">載入中…</CardContent>
      </Card>
    );
  }

  const counts = {
    matched: lines.filter((l) => l.reconciliationStatus === "matched").length,
    suggested: lines.filter((l) => l.reconciliationStatus === "suggested").length,
    unmatched: lines.filter((l) => l.reconciliationStatus === "unmatched").length,
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>勾稽狀態摘要</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {lines.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">目前沒有對帳單明細列。</div>
        ) : (
          <Link href="/reconciliation" className="flex items-center justify-around gap-2 px-4 py-3 no-underline hover:bg-accent">
            <ReconciliationCount label={RECONCILIATION_STATUS_LABELS.matched} count={counts.matched} variant="success" />
            <ReconciliationCount label={RECONCILIATION_STATUS_LABELS.suggested} count={counts.suggested} variant="warning" />
            <ReconciliationCount label={RECONCILIATION_STATUS_LABELS.unmatched} count={counts.unmatched} variant="destructive" />
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

function ReconciliationCount({ label, count, variant }: { label: string; count: number; variant: BadgeProps["variant"] }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="font-mono text-xl font-bold text-foreground">{count}</span>
      <Badge variant={variant}>{label}</Badge>
    </div>
  );
}

// 待處理事項(2026-09-07 補完設計落差任務書任務 4)—— 排序邏輯:待覆核文件視為「本週日
// 前要清完」,建立時間早於本週一的視為上週遺留(逾期,daysLeft 是負數);保固/訂閱項目
// 用自己的到期日算 daysLeft。全部依 daysLeft 由小到大排序,逾期項目自然排最前面(負數最小),
// 越接近本週日的排越前面,符合任務書「距離本週日還剩幾天，由近到遠排序」的要求。這個排序
// 定義是我依任務書文字自己實作的判斷,還沒有給 Theo 確認過細節。
interface TodoEntry {
  key: string;
  label: string;
  sub: string;
  daysLeft: number;
  overdue: boolean;
  href: string;
}

function TodoWidget({ documents, warranty }: { documents: DocumentRow[] | null; warranty: WarrantyItem[] | null }) {
  if (documents === null || warranty === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>待處理事項</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">載入中…</CardContent>
      </Card>
    );
  }

  const now = new Date();
  const reviewEntries: TodoEntry[] = documents
    .filter((d) => d.status === "review")
    .map((d) => {
      const overdue = isBeforeThisWeek(d.createdAt.slice(0, 10), now);
      return {
        key: `doc-${d.id}`,
        label: d.vendorNameRaw ?? d.id,
        sub: `待覆核文件・${d.id}`,
        daysLeft: overdue ? -1 - daysSince(d.createdAt, now) : daysUntilEndOfWeek(now),
        overdue,
        href: `/review`,
      };
    });

  const warrantyEntries: TodoEntry[] = warranty
    .filter((w) => (w.status === "due_soon" && isThisWeek(w.endDate, now)) || w.status === "expired")
    .map((w) => ({
      key: `wsu-${w.id}`,
      label: w.name,
      sub: `保固/訂閱到期・${w.endDate}`,
      daysLeft: daysUntil(w.endDate, now),
      overdue: w.status === "expired",
      href: "/warranty",
    }));

  const entries = [...reviewEntries, ...warrantyEntries].sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 8);

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>待處理事項</CardTitle>
        <p className="text-xs text-foreground-3">依優先級排序,越接近本週日或已逾期的排越前面</p>
      </CardHeader>
      <CardContent className="p-0">
        {entries.length === 0 && <div className="p-4 text-sm text-muted-foreground">本週沒有待處理事項。</div>}
        {entries.map((e) => (
          <Link key={e.key} href={e.href} className="flex items-center gap-3 border-b border-line-2 px-4 py-2.5 no-underline last:border-0 hover:bg-accent">
            <Badge variant={e.overdue ? "destructive" : "warning"}>{e.overdue ? "逾期" : `剩 ${e.daysLeft} 天`}</Badge>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-foreground">{e.label}</span>
              <span className="block truncate text-[11.5px] text-foreground-3">{e.sub}</span>
            </span>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

// 即將到期的保固與訂閱(任務 3 要求的 dashboard widget)。
function WarrantyWidget({ warranty }: { warranty: WarrantyItem[] | null }) {
  const items = (warranty ?? []).filter((w) => w.status !== "active").slice(0, 5);
  return (
    <Card>
      <CardHeader>
        <CardTitle>即將到期的保固與訂閱</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {warranty === null && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
        {warranty !== null && items.length === 0 && <div className="p-4 text-sm text-muted-foreground">近期沒有即將到期的項目。</div>}
        {items.map((w) => (
          <Link key={w.id} href="/warranty" className="flex items-center justify-between gap-3 border-b border-line-2 px-4 py-2.5 no-underline last:border-0 hover:bg-accent">
            <span className="min-w-0">
              <span className="block truncate text-[12.5px] font-medium text-foreground">{w.name}</span>
              <span className="block text-[11px] text-foreground-3">{OWNERSHIP_LABELS[w.ownership]}</span>
            </span>
            <span className="flex-none font-mono text-xs text-foreground-2">{w.endDate}</span>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

// 本週新匯入文件(任務 1)—— 依歸屬分類做進度條:本週(週一~週日)建立的文件,按 ownership
// 分組算比例。
function WeeklyImportsWidget({ documents }: { documents: DocumentRow[] | null }) {
  if (documents === null) {
    return (
      <Card className="p-4">
        <h2 className="mb-3 text-sm font-bold">本週新匯入文件</h2>
        <p className="text-sm text-muted-foreground">載入中…</p>
      </Card>
    );
  }

  const now = new Date();
  const weekDocs = documents.filter((d) => isThisWeek(d.createdAt.slice(0, 10), now));
  const total = weekDocs.length;
  const byOwnership = (Object.keys(OWNERSHIP_LABELS) as OwnershipScope[])
    .map((scope) => ({ scope, count: weekDocs.filter((d) => d.ownership === scope).length }))
    .filter((g) => g.count > 0);

  return (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-bold">本週新匯入文件</h2>
      {total === 0 ? (
        <p className="text-sm text-muted-foreground">本週還沒有新匯入的文件。</p>
      ) : (
        byOwnership.map((g) => (
          <div key={g.scope} className="mb-3 last:mb-0">
            <div className="mb-1.5 flex items-center justify-between">
              <Badge variant="outline">{OWNERSHIP_LABELS[g.scope]}</Badge>
              <span className="text-xs text-foreground-2">
                <b className="font-mono text-sm text-foreground">{g.count}</b> 份
              </span>
            </div>
            <div className="h-1.5 bg-line-2">
              <div className="h-full bg-brand" style={{ width: `${(g.count / total) * 100}%` }} />
            </div>
          </div>
        ))
      )}
    </Card>
  );
}

// 本月摘要(任務 1)—— 完整度定義跟 apps/api/src/scheduled.ts 的 runMonthlyReview() 用
// 同一個公式(本月新進文件中已歸檔的比例),兩邊如果之後要調整定義要一起改。
function MonthSummaryWidget({ documents }: { documents: DocumentRow[] | null }) {
  if (documents === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>本月摘要</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">載入中…</CardContent>
      </Card>
    );
  }

  const monthDocs = documents.filter((d) => isThisMonth(d.createdAt));
  const archived = monthDocs.filter((d) => d.status === "archived").length;
  const total = monthDocs.length;
  const pct = total > 0 ? Math.round((archived / total) * 100) : 100;
  const missing = total - archived;

  return (
    <Card>
      <CardHeader>
        <CardTitle>本月摘要</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-1.5 flex items-center justify-between text-[11.5px] text-foreground-2">
          <span>本月憑證完整度</span>
          <span className="font-medium text-foreground">{pct}%</span>
        </div>
        <div className="flex h-2 overflow-hidden bg-line-2">
          <div className="bg-ok" style={{ width: `${pct}%` }} />
          <div className="bg-warning-line" style={{ width: `${100 - pct}%` }} />
        </div>
        <p className="mt-1.5 text-[11px] text-foreground-3">
          {missing > 0 ? `${missing} 筆本月文件還沒歸檔完成` : "本月文件都已歸檔"}(共 {total} 筆)
        </p>
      </CardContent>
    </Card>
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
    <Link href={href} className="flex flex-col gap-2 border border-line bg-card p-3.5 no-underline hover:border-border">
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

function daysSince(iso: string, now: Date): number {
  const then = new Date(iso);
  return Math.max(0, Math.round((now.getTime() - then.getTime()) / (24 * 60 * 60 * 1000)));
}
