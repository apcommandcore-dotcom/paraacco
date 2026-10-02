"use client";

// 定期繳費(2026-09-29,CODE_TASK_recurring-bills-single-page_20260929_V1.01.md)——所有定期繳費的唯一入口:
//   1. 項目清單(一個 recurring_series 一列):名稱、分類、供應商(統編對應主檔)、範圍、週期、本期金額、繳費方式、
//      用戶號碼、下期繳費日、狀態(逾期未繳/即將繳費/未到期)、「已繳」(下期繳費日依週期推一期)。
//   2. 分類分頁:全部/水費/電費/…/其他;?category=water 或群組 ?category=water,electricity,gas(依標題瀏覽的分類卡片連過來)。
//   3. 月份檢核格狀表(2026-09-28 的「定期帳單月份檢核」保留):有/缺/只有催繳/加密/無需帳單,點格子看 DOC、標記。
//   4. 點項目名稱:列出它所有月份的帳單文件。
//   5. 新增/編輯項目:原 /warranty 的定期繳費欄位 + series 的起訖月份、match_rule。
// 訂閱(例 Claude Pro)不算定期繳費,在「保固與訂閱」。配色沿用 ok/warn/err/info 語意色(見 ui/badge.tsx)。
//
// 2026-10-01(CODE_TASK_recurring-bills-single-page_20260929_V1.04.md 第五節):項目只建一次,每一期(recurring_periods)
// 由系統自動產生、自動掛帳單/繳費證明/對帳單扣款。清單顯示本期金額(小字上期)、本期狀態(未到期/即將繳費/待對帳/帳單未到/
// 缺繳款證明/逾期未繳)、下期繳費日(由期次算);點名稱開項目詳情看期次並手動掛/拆;「待覆核掛期」集中在頁首;
// 新增項目存檔後立即回溯掛期,結果顯示在頁首,可一鍵撤回;月份格子顏色依期次狀態。

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, Pencil, Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { centsToInput, formatCents } from "@/lib/format";
import {
  apiFetch,
  CADENCE_LABELS,
  COVERAGE_STATUS_LABELS,
  DOC_STATUS_LABELS,
  OWNERSHIP_LABELS,
  PAID_SOURCE_LABELS,
  PAYMENT_METHOD_LABELS,
  PERIOD_DISPLAY_LABELS,
  PERIOD_DISPLAY_VARIANT,
  REVIEW_REASON_LABELS,
  RECURRING_CATEGORY_LABELS,
  RECURRING_DUE_STATUS_LABELS,
  type CoverageCell,
  type CoverageResponse,
  type CoverageSeries,
  type CoverageStatus,
  type DocumentStatus,
  type EntityRow,
  type OwnershipScope,
  type PaymentMethod,
  type RecurringCadence,
  type RecurringDueStatus,
  type PeriodDisplayStatus,
  type RecurringPeriodRow,
  type RecurringReview,
  type RecurringSeriesRow,
  type VendorRow,
} from "@/lib/api";

const STATUS_CLASS: Record<CoverageStatus, string> = {
  present: "border-ok-line bg-ok-bg text-ok",
  reminder_only: "border-warning-line bg-warning-bg text-warning",
  encrypted: "border-info-line bg-info-bg text-info",
  not_required: "border-line bg-muted text-foreground-3",
  missing: "border-destructive-line bg-destructive-bg text-destructive",
};

const STATUS_GLYPH: Record<CoverageStatus, string> = {
  present: "●",
  reminder_only: "!",
  encrypted: "鎖",
  not_required: "—",
  missing: "✕",
};

const PERIOD_CLASS: Record<PeriodDisplayStatus, string> = {
  paid: "border-ok-line bg-ok-bg text-ok",
  waived: "border-line bg-muted text-foreground-3",
  debited: "border-warning-line bg-warning-bg text-warning",
  proof_missing: "border-destructive-line bg-destructive-bg text-destructive",
  pending_statement: "border-info-line bg-info-bg text-info",
  bill_missing: "border-warning-line bg-warning-bg text-warning",
  overdue: "border-destructive-line bg-destructive-bg text-destructive",
  due_soon: "border-warning-line bg-card text-warning",
  not_due: "border-line bg-card text-foreground-3",
};
const PERIOD_GLYPH: Record<PeriodDisplayStatus, string> = {
  paid: "●",
  waived: "—",
  debited: "扣",
  proof_missing: "證",
  pending_statement: "對",
  bill_missing: "?",
  overdue: "✕",
  due_soon: "!",
  not_due: "○",
};

const DUE_VARIANT: Record<RecurringDueStatus, "destructive" | "warning" | "success" | "outline"> = {
  overdue: "destructive",
  due_soon: "warning",
  not_due: "success",
  unscheduled: "outline",
};

const CATEGORY_KEYS = Object.keys(RECURRING_CATEGORY_LABELS);
const nt = (cents: number | null | undefined) => formatCents(cents);

function monthIndex(m: string): number {
  return Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
}

function monthFromIndex(i: number): string {
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

function defaultRange(): { from: string; to: string } {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const last = now.getUTCFullYear() * 12 + now.getUTCMonth() - 1;
  return { from: monthFromIndex(last - 23), to: monthFromIndex(last) };
}

function scopeLabel(s: RecurringSeriesRow, entities: EntityRow[]): string {
  const entity = s.entityId ? (entities.find((e) => e.id === s.entityId)?.name ?? s.entityId) : null;
  const own = s.ownership && s.ownership !== "pending" ? (OWNERSHIP_LABELS[s.ownership as OwnershipScope] ?? s.ownership) : s.ownership === "pending" ? "未分流" : null;
  return [entity, own].filter(Boolean).join(" · ") || "—";
}

function RecurringRoot() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const categoryParam = searchParams.get("category");
  const selectedCategories = useMemo(() => (categoryParam ? categoryParam.split(",").filter((c) => CATEGORY_KEYS.includes(c)) : []), [categoryParam]);
  const initial = useMemo(defaultRange, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [data, setData] = useState<CoverageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ series: CoverageSeries; cell: CoverageCell } | null>(null);
  const [docsFor, setDocsFor] = useState<RecurringSeriesRow | null>(null);
  const [reviews, setReviews] = useState<RecurringReview[]>([]);
  const [backfillResult, setBackfillResult] = useState<{ seriesId: string; result: BackfillResult } | null>(null);
  const [editing, setEditing] = useState<RecurringSeriesRow | "new" | null>(null);
  const [onlyGaps, setOnlyGaps] = useState(false);
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [vendors, setVendors] = useState<VendorRow[]>([]);

  const load = useCallback(() => {
    setError(null);
    apiFetch<CoverageResponse>(`/api/recurring/coverage?from=${from}&to=${to}`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [from, to]);

  useEffect(load, [load]);
  const loadReviews = useCallback(() => {
    apiFetch<{ reviews: RecurringReview[] }>("/api/recurring/reviews")
      .then((d) => setReviews(d.reviews))
      .catch(() => setReviews([]));
  }, []);
  useEffect(loadReviews, [loadReviews]);
  async function decide(r: RecurringReview, decision: "accept" | "reject") {
    await apiFetch(`/api/recurring/reviews/${r.id}/${decision}`, { method: "POST", body: JSON.stringify({}) }).catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
    loadReviews();
    load();
  }
  async function undoBackfill() {
    if (!backfillResult) return;
    await apiFetch(`/api/recurring/series/${backfillResult.seriesId}/backfill/undo`, { method: "POST", body: JSON.stringify(backfillResult.result) }).catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
    setBackfillResult(null);
    load();
  }
  useEffect(() => {
    apiFetch<{ entities: EntityRow[] }>("/api/entities")
      .then((d) => setEntities(d.entities))
      .catch(() => {});
    apiFetch<{ vendors: VendorRow[] }>("/api/vendors")
      .then((d) => setVendors(d.vendors))
      .catch(() => {});
  }, []);

  const setCategory = (cats: string[]) => router.replace(cats.length ? `/recurring?category=${cats.join(",")}` : "/recurring");

  const allSeries = data?.series ?? [];
  const inCategory = (s: RecurringSeriesRow) => !selectedCategories.length || selectedCategories.includes(s.category ?? "other");
  const categoryCounts = allSeries.reduce<Record<string, number>>((acc, s) => ((acc[s.category ?? "other"] = (acc[s.category ?? "other"] ?? 0) + 1), acc), {});
  const items = allSeries.filter(inCategory);
  const allSeriesNames = new Map(allSeries.map((s) => [s.id, s.name]));

  const months = useMemo(() => {
    if (!data) return [];
    const out: string[] = [];
    for (let i = monthIndex(data.from); i <= monthIndex(data.to); i++) out.push(monthFromIndex(i));
    return out;
  }, [data]);

  const rows = items.filter((s) => !onlyGaps || s.summary.missing > 0);
  const totals = items.reduce(
    (acc, s) => ({ expected: acc.expected + s.summary.expected, missing: acc.missing + s.summary.missing, present: acc.present + s.summary.present }),
    { expected: 0, missing: 0, present: 0 },
  );

  async function markPaid(s: RecurringSeriesRow) {
    if (!confirm(`「${s.name}」目前未付的那一期標成已繳(手動,無證明)?之後帳單/證明/對帳單會自動掛進來,一般不需要手動按。`)) return;
    await apiFetch(`/api/recurring/series/${s.id}/advance`, { method: "POST", body: JSON.stringify({}) }).catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
    load();
  }

  return (
    <AppShell>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2.5">
          <h1 className="m-0 text-[23px] font-extrabold tracking-tight">定期繳費</h1>
          <span className="font-mono text-[10px] tracking-[0.16em] text-foreground-3">RECURRING</span>
        </div>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus size={14} className="mr-1" />
          新增項目
        </Button>
      </div>
      <p className="mb-4 text-sm text-foreground-2">
        水費、電費、瓦斯、網路、電信、勞保、健保、勞退、稅金、保險、租金、會費等定期繳費都在這一頁;掛上項目的帳單不會出現在一般消費列表(可在列表打開「包含定期繳費」)。訂閱在{" "}
        <Link href="/warranty" className="text-primary hover:underline">
          保固與訂閱
        </Link>
        。
      </p>

      <div className="mb-4 flex flex-wrap gap-1 border-b border-line-2">
        <button
          type="button"
          onClick={() => setCategory([])}
          className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${!selectedCategories.length ? "border-foreground font-semibold" : "border-transparent text-foreground-2 hover:text-foreground"}`}
        >
          全部<span className="ml-1 font-mono text-[10px] text-foreground-3">{allSeries.length}</span>
        </button>
        {CATEGORY_KEYS.map((k) => {
          const active = selectedCategories.length === 1 && selectedCategories[0] === k;
          const inGroup = selectedCategories.length > 1 && selectedCategories.includes(k);
          return (
            <button
              key={k}
              type="button"
              onClick={() => setCategory([k])}
              className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${active ? "border-foreground font-semibold" : inGroup ? "border-line text-foreground" : "border-transparent text-foreground-2 hover:text-foreground"}`}
            >
              {RECURRING_CATEGORY_LABELS[k]}
              <span className="ml-1 font-mono text-[10px] text-foreground-3">{categoryCounts[k] ?? 0}</span>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {backfillResult && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border border-info-line bg-info-bg p-3 text-xs">
          <span>
            已新增 {backfillResult.seriesId},立即回溯:建立 {backfillResult.result.createdPeriods} 期、掛上帳單/證明 {backfillResult.result.attachedDocs.length} 份
            {backfillResult.result.attachedDocs.length ? `(${backfillResult.result.attachedDocs.map((d) => `${d.documentId}→${d.periodKey}`).join("、")})` : ""}
            、對帳單扣款 {backfillResult.result.attachedLines.length} 筆、待覆核 {backfillResult.result.reviews.length} 筆。
          </span>
          <span className="flex gap-2">
            <Button size="sm" variant="outline" onClick={undoBackfill}>
              撤回這次掛期
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setBackfillResult(null)}>
              關閉
            </Button>
          </span>
        </div>
      )}

      {reviews.length > 0 && (
        <Card className="mb-4">
          <CardContent className="p-0">
            <div className="border-b border-line-2 px-3 py-2 text-xs font-semibold">待覆核掛期({reviews.length})</div>
            <Table className="text-xs">
              <TableBody>
                {reviews.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">
                      <Badge variant="warning">{REVIEW_REASON_LABELS[r.reason] ?? r.reason}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono">
                      {r.documentId ? (
                        <Link href={`/review?doc=${r.documentId}`} className="text-primary hover:underline">
                          {r.documentId}
                        </Link>
                      ) : (
                        `對帳明細 #${r.statementLineId}`
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {r.seriesId ? (allSeriesNames.get(r.seriesId) ?? r.seriesId) : "—"} {r.periodKey ?? ""}
                    </TableCell>
                    <TableCell className="text-foreground-2">{r.note}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {r.seriesId && r.periodKey && (
                        <button type="button" className="mr-3 text-primary hover:underline" onClick={() => decide(r, "accept")}>
                          確認掛上
                        </button>
                      )}
                      <button type="button" className="text-foreground-3 hover:underline" onClick={() => decide(r, "reject")}>
                        不是
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card className="mb-6">
        <CardContent className="overflow-x-auto p-0">
          {!data && !error && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
          {data && items.length === 0 && <div className="p-4 text-sm text-muted-foreground">這個分類還沒有定期繳費項目。</div>}
          {items.length > 0 && (
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead>名稱</TableHead>
                  <TableHead>分類</TableHead>
                  <TableHead>供應商</TableHead>
                  <TableHead>範圍</TableHead>
                  <TableHead>週期</TableHead>
                  <TableHead>繳費方式</TableHead>
                  <TableHead className="text-right">本期金額</TableHead>
                  <TableHead>本期狀態</TableHead>
                  <TableHead>下期繳費日</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((s) => {
                  const due = s.dueStatus ?? "unscheduled";
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="max-w-[220px]">
                        <button type="button" onClick={() => setDocsFor(s)} className="text-left font-medium text-foreground hover:underline" title="項目詳情:每一期的帳單、證明、扣款">
                          {s.name}
                        </button>
                        <div className="text-[10px] text-foreground-3">
                          {s.startMonth}~{s.endMonth ?? "仍在繳"}
                          {s.needsDocument === false && " · 無需帳單"}
                          {s.requireProof && " · 需繳款證明"}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{s.category ? (RECURRING_CATEGORY_LABELS[s.category] ?? s.category) : "—"}</TableCell>
                      <TableCell className="max-w-[160px] truncate text-muted-foreground" title={s.vendorName ?? undefined}>
                        {s.vendorName ?? "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{scopeLabel(s, entities)}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{CADENCE_LABELS[s.cadence]}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{s.paymentMethod ? PAYMENT_METHOD_LABELS[s.paymentMethod] : "—"}</TableCell>
                      <TableCell className="whitespace-nowrap text-right font-mono">
                        {nt(s.amountCents)}
                        {s.previousAmountCents != null && <div className="text-[10px] text-foreground-3">上期 {nt(s.previousAmountCents)}</div>}
                      </TableCell>
                      <TableCell>
                        {s.currentStatus ? (
                          <Badge variant={PERIOD_DISPLAY_VARIANT[s.currentStatus]}>
                            {PERIOD_DISPLAY_LABELS[s.currentStatus]}
                            {s.currentPeriodKey ? ` · ${s.currentPeriodKey}` : ""}
                          </Badge>
                        ) : due !== "unscheduled" ? (
                          <Badge variant={DUE_VARIANT[due]}>{RECURRING_DUE_STATUS_LABELS[due]}</Badge>
                        ) : (
                          <span className="text-foreground-3" title="還沒有期次(既有項目要等回溯掛期寫入)">—</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono">{s.nextDueDate ?? "—"}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        <button type="button" onClick={() => markPaid(s)} className="mr-3 text-xs text-primary hover:underline" title="後備:把目前未付的那一期標成手動已繳(無證明)">
                          已繳
                        </button>
                        <button type="button" onClick={() => setEditing(s)} className="text-foreground-3 hover:text-foreground" aria-label="編輯">
                          <Pencil size={13} />
                        </button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="m-0 text-base font-bold">月份檢核</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            月份依覆核時確認的「帳單月份」計算。信用卡、證券的「缺」不一定是漏存——沒有消費/交易的月份可以標成「無需帳單」。
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2 text-xs">
          <label>
            <span className="mb-1 block text-muted-foreground">起</span>
            <Input type="month" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="h-8 w-[140px] text-xs" />
          </label>
          <label>
            <span className="mb-1 block text-muted-foreground">迄</span>
            <Input type="month" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} className="h-8 w-[140px] text-xs" />
          </label>
          <label className="flex h-8 items-center gap-1.5">
            <input type="checkbox" checked={onlyGaps} onChange={(e) => setOnlyGaps(e.target.checked)} />
            只看有缺的
          </label>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        {(Object.keys(COVERAGE_STATUS_LABELS) as CoverageStatus[]).map((st) => (
          <span key={st} className="inline-flex items-center gap-1.5">
            <span className={`inline-flex h-4 w-4 items-center justify-center border text-[9px] ${STATUS_CLASS[st]}`}>{STATUS_GLYPH[st]}</span>
            {COVERAGE_STATUS_LABELS[st]}
          </span>
        ))}
        {data && (
          <span className="ml-auto font-mono">
            應有 {totals.expected} · 有 {totals.present} · 缺 {totals.missing}
          </span>
        )}
      </div>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          {data && rows.length === 0 && <div className="p-4 text-sm text-muted-foreground">沒有符合的項目。</div>}
          {data && rows.length > 0 && (
            <table className="border-collapse text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="sticky left-0 z-10 min-w-[140px] bg-card px-3 py-2 text-left font-medium md:min-w-[200px]">項目</th>
                  <th className="px-2 py-2 text-right font-medium">有/應有</th>
                  {months.map((m) => (
                    <th key={m} className="w-[26px] px-0 py-2 text-center font-mono text-[10px] font-normal text-muted-foreground">
                      {m.endsWith("-01") || m === months[0] ? <div className="text-foreground">{m.slice(2, 4)}</div> : <div>&nbsp;</div>}
                      {Number(m.slice(5))}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const byMonth = new Map(s.months.map((c) => [c.month, c]));
                  return (
                    <tr key={s.id} className="border-b border-line-2 last:border-0">
                      <td className="sticky left-0 z-10 bg-card px-3 py-1.5">
                        <div className="font-medium">{s.name}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {CADENCE_LABELS[s.cadence]} · {s.startMonth}~{s.endMonth ?? "仍在繳"}
                          {s.ownership && s.ownership !== "pending" ? ` · ${OWNERSHIP_LABELS[s.ownership as OwnershipScope] ?? s.ownership}` : ""}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono">
                        {s.summary.present}/{s.summary.expected}
                        {s.summary.missing > 0 && <span className="ml-1 text-destructive">缺{s.summary.missing}</span>}
                      </td>
                      {months.map((m) => {
                        const cell = byMonth.get(m);
                        if (!cell) return <td key={m} className="px-0 py-1.5" />;
                        return (
                          <td key={m} className="px-[2px] py-1.5 text-center">
                            <button
                              type="button"
                              title={`${m} ${cell.periodStatus ? PERIOD_DISPLAY_LABELS[cell.periodStatus] : COVERAGE_STATUS_LABELS[cell.status]}${cell.expected ? "" : "(非應有月份)"}`}
                              onClick={() => setSelected({ series: s, cell })}
                              className={`inline-flex h-[22px] w-[22px] items-center justify-center border text-[10px] ${cell.periodStatus ? PERIOD_CLASS[cell.periodStatus] : STATUS_CLASS[cell.status]} ${
                                cell.expected ? "" : "border-dashed opacity-70"
                              }`}
                            >
                              {cell.periodStatus ? PERIOD_GLYPH[cell.periodStatus] : STATUS_GLYPH[cell.status]}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <CellDrawer
        selected={selected}
        onClose={() => setSelected(null)}
        onChanged={() => {
          setSelected(null);
          load();
        }}
      />
      <SeriesDetailDrawer
        series={docsFor}
        onClose={() => setDocsFor(null)}
        onChanged={() => {
          load();
          loadReviews();
        }}
      />
      <SeriesFormDrawer
        editing={editing}
        entities={entities}
        vendors={vendors}
        onClose={() => setEditing(null)}
        onSaved={(created) => {
          setEditing(null);
          if (created) setBackfillResult(created);
          load();
          loadReviews();
        }}
      />
    </AppShell>
  );
}

// ---- 項目詳情:期次(V1.04 第五節 2)----
interface BackfillResult {
  createdPeriods: number;
  attachedDocs: Array<{ documentId: string; periodKey: string }>;
  attachedLines: number[];
  reviews: number[];
}

function SeriesDetailDrawer({ series, onClose, onChanged }: { series: RecurringSeriesRow | null; onClose: () => void; onChanged: () => void }) {
  const [periods, setPeriods] = useState<RecurringPeriodRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attach, setAttach] = useState<{ periodId: number; documentId: string; role: string } | null>(null);
  const load = useCallback(() => {
    if (!series) return;
    apiFetch<{ periods: RecurringPeriodRow[] }>(`/api/recurring/series/${series.id}/periods`)
      .then((d) => setPeriods(d.periods))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [series]);
  useEffect(() => {
    setPeriods(null);
    setError(null);
    setAttach(null);
    load();
  }, [load]);
  async function act(path: string, body: unknown) {
    setError(null);
    try {
      await apiFetch(path, { method: "POST", body: JSON.stringify(body) });
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  const docLink = (id: string | null) =>
    id ? (
      <Link href={`/documents?view=document&id=${id}`} className="font-mono text-primary hover:underline">
        {id}
      </Link>
    ) : (
      <span className="text-foreground-3">—</span>
    );
  return (
    <Drawer open={!!series} onClose={onClose} title={series ? `${series.name} · 期次` : ""}>
      {error && <div className="mb-2 text-xs text-destructive">{error}</div>}
      {series && periods === null && !error && <div className="text-sm text-muted-foreground">載入中…</div>}
      {periods?.length === 0 && <div className="text-sm text-muted-foreground">這個項目還沒有期次(既有項目要等回溯掛期寫入;新增的項目存檔後會自動產生)。</div>}
      {periods && periods.length > 0 && (
        <div className="space-y-2 text-xs">
          {periods.map((p) => (
            <div key={p.id} className="border border-line-2 p-2">
              <div className="flex flex-wrap items-center justify-between gap-1">
                <span className="font-mono font-semibold">{p.periodMonths.join("~")}</span>
                <Badge variant={PERIOD_DISPLAY_VARIANT[p.displayStatus]}>{PERIOD_DISPLAY_LABELS[p.displayStatus]}</Badge>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-foreground-2">
                <span>金額 {nt(p.amountCents)}</span>
                <span>
                  繳費期限 {p.dueDate ?? "—"}
                  {p.dueDateSource === "estimated" && p.dueDate ? <span className="text-foreground-3">(預估)</span> : null}
                </span>
                <span>帳單 {docLink(p.billDocId)}</span>
                <span>證明 {docLink(p.proofDocId)}</span>
                <span className="col-span-2">
                  扣款 {p.statementLine ? `${p.statementLine.date} ${p.statementLine.description} ${nt(Math.abs(p.statementLine.amountCents))}` : "—"}
                  {p.billMissingFlag && <span className="ml-1 text-warning">(帳單未到)</span>}
                </span>
                <span className="col-span-2">
                  付款來源 {p.paidSource ? PAID_SOURCE_LABELS[p.paidSource] ?? p.paidSource : "—"}
                  {p.matchNote ? <span className="ml-1 text-foreground-3">· {p.matchNote}</span> : null}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                <button type="button" className="text-primary hover:underline" onClick={() => setAttach({ periodId: p.id, documentId: "", role: "" })}>
                  掛文件
                </button>
                {p.billDocId && (
                  <button type="button" className="text-destructive hover:underline" onClick={() => confirm(`把帳單 ${p.billDocId} 從這一期拆掉?文件會回到一般列表。`) && act(`/api/recurring/periods/${p.id}/detach`, { documentId: p.billDocId })}>
                    拆帳單
                  </button>
                )}
                {p.proofDocId && (
                  <button type="button" className="text-destructive hover:underline" onClick={() => confirm(`把證明 ${p.proofDocId} 從這一期拆掉?`) && act(`/api/recurring/periods/${p.id}/detach`, { documentId: p.proofDocId })}>
                    拆證明
                  </button>
                )}
                {p.status !== "paid" && (
                  <button type="button" className="text-primary hover:underline" onClick={() => act(`/api/recurring/periods/${p.id}/status`, { action: "paid" })}>
                    手動標已繳(無證明)
                  </button>
                )}
                {p.status !== "waived" && (
                  <button type="button" className="text-foreground-3 hover:underline" onClick={() => act(`/api/recurring/periods/${p.id}/status`, { action: "waived" })}>
                    無需帳單
                  </button>
                )}
                {(p.status === "paid" || p.status === "waived") && (
                  <button type="button" className="text-foreground-3 hover:underline" onClick={() => act(`/api/recurring/periods/${p.id}/status`, { action: "reset" })}>
                    依掛上的文件重算
                  </button>
                )}
              </div>
              {attach?.periodId === p.id && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <Input value={attach.documentId} onChange={(e) => setAttach({ ...attach, documentId: e.target.value.trim() })} placeholder="DOC-2026-000123" className="h-7 w-40 font-mono text-[11px]" />
                  <select value={attach.role} onChange={(e) => setAttach({ ...attach, role: e.target.value })} className="h-7 border border-input bg-background px-1 text-[11px]">
                    <option value="">自動判斷角色</option>
                    <option value="bill">帳單</option>
                    <option value="proof">繳費證明</option>
                    <option value="bill_and_proof">帳單兼證明</option>
                  </select>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!/^DOC-\d{4}-\d{6}$/.test(attach.documentId)}
                    onClick={() => {
                      act(`/api/recurring/periods/${p.id}/attach`, { documentId: attach.documentId, role: attach.role || undefined });
                      setAttach(null);
                    }}
                  >
                    掛上
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}

// ---- 新增/編輯項目 ----
/** match_rule JSON 裡的清單欄位 → 逗號分隔字串(表單用)。 */
function ruleList(raw: string | null | undefined, key: "accountRefs" | "statementKeywords", extra?: string | null): string {
  let list: string[] = [];
  try {
    const v = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (Array.isArray(v[key])) list = (v[key] as unknown[]).map(String);
    if (key === "accountRefs" && typeof v.accountRef === "string") list.push(v.accountRef);
  } catch {
    // 舊資料 JSON 壞掉就當空的
  }
  if (extra) list.push(extra);
  return [...new Set(list.map((x) => x.trim()).filter(Boolean))].join(", ");
}

function toForm(s: RecurringSeriesRow | null) {
  return {
    name: s?.name ?? "",
    category: s?.category ?? "water",
    vendorId: s?.vendorId ?? "",
    entityId: s?.entityId ?? "",
    ownership: s?.ownership ?? "per",
    cadence: (s?.cadence ?? "monthly") as RecurringCadence,
    startMonth: s?.startMonth ?? "",
    endMonth: s?.endMonth ?? "",
    amount: centsToInput(s?.amountCents),
    paymentMethod: (s?.paymentMethod ?? "") as "" | PaymentMethod,
    remindDays: String(s?.remindDays ?? 7),
    needsDocument: s?.needsDocument ?? true,
    matchRule: s?.matchRule ?? "",
    accountRefs: ruleList(s?.matchRule, "accountRefs", s?.accountRef),
    statementKeywords: ruleList(s?.matchRule, "statementKeywords"),
    amountMode: s?.amountMode ?? "variable",
    dueRule: s?.dueRule ?? "bill",
    dueDay: s?.dueDay != null ? String(s.dueDay) : "",
    requireProof: s?.requireProof ?? false,
    note: s?.note ?? "",
  };
}

/** "1234.5" → 123450(字串運算,避免浮點誤差);空字串 → null;格式錯 → undefined。 */
function toCents(input: string): number | null | undefined {
  const t = input.trim();
  if (!t) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  const [whole, frac = ""] = t.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

function SeriesFormDrawer({
  editing,
  entities,
  vendors,
  onClose,
  onSaved,
}: {
  editing: RecurringSeriesRow | "new" | null;
  entities: EntityRow[];
  vendors: VendorRow[];
  onClose: () => void;
  onSaved: (created?: { seriesId: string; result: BackfillResult }) => void;
}) {
  const current = editing && editing !== "new" ? editing : null;
  const [form, setForm] = useState(toForm(null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setForm(toForm(current));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const cents = toCents(form.amount);
  const canSave = !!form.name.trim() && /^\d{4}-\d{2}$/.test(form.startMonth) && cents !== undefined && !busy;
  const set = <K extends keyof ReturnType<typeof toForm>>(k: K, v: ReturnType<typeof toForm>[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      let rule: Record<string, unknown> = {};
      if (form.matchRule.trim()) {
        try {
          rule = JSON.parse(form.matchRule) as Record<string, unknown>;
        } catch {
          throw new Error("比對規則 match_rule 不是合法的 JSON");
        }
      }
      const split = (t: string) => t.split(/[,、\n]+/).map((x) => x.trim()).filter(Boolean);
      rule.accountRefs = split(form.accountRefs);
      rule.statementKeywords = split(form.statementKeywords);
      delete rule.accountRef;
      const body = {
        name: form.name.trim(),
        category: form.category || null,
        vendorId: form.vendorId || null,
        entityId: form.entityId || null,
        ownership: form.ownership || null,
        cadence: form.cadence,
        startMonth: form.startMonth,
        endMonth: form.endMonth || null,
        amountCents: cents,
        paymentMethod: form.paymentMethod || null,
        accountRef: split(form.accountRefs)[0] ?? null,
        remindDays: Number(form.remindDays) || 0,
        needsDocument: form.needsDocument,
        matchRule: rule,
        amountMode: form.amountMode,
        dueRule: form.dueRule,
        dueDay: form.dueDay.trim() ? Number(form.dueDay) : null,
        requireProof: form.requireProof,
        note: form.note.trim() || null,
      };
      const res = await apiFetch<{ id?: string; backfill?: BackfillResult }>(current ? `/api/recurring/series/${current.id}` : "/api/recurring/series", {
        method: "POST",
        body: JSON.stringify(body),
      });
      onSaved(!current && res.id && res.backfill ? { seriesId: res.id, result: res.backfill } : undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const sel = "h-8 w-full border border-input bg-background px-2 text-xs";
  return (
    <Drawer open={!!editing} onClose={onClose} title={current ? `編輯 · ${current.name}` : "新增定期繳費項目"}>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <F label="名稱" wide>
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} className="h-8 text-xs" />
        </F>
        <F label="分類">
          <select value={form.category} onChange={(e) => set("category", e.target.value)} className={sel}>
            {CATEGORY_KEYS.map((k) => (
              <option key={k} value={k}>
                {RECURRING_CATEGORY_LABELS[k]}
              </option>
            ))}
          </select>
        </F>
        <F label="供應商(主檔)">
          <select value={form.vendorId} onChange={(e) => set("vendorId", e.target.value)} className={sel}>
            <option value="">—</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.taxId ? ` (${v.taxId})` : ""}
              </option>
            ))}
          </select>
        </F>
        <F label="範圍:主體">
          <select value={form.entityId} onChange={(e) => set("entityId", e.target.value)} className={sel}>
            <option value="">—(家庭個人)</option>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </F>
        <F label="範圍:歸屬">
          <select value={form.ownership} onChange={(e) => set("ownership", e.target.value)} className={sel}>
            {(Object.keys(OWNERSHIP_LABELS) as OwnershipScope[]).map((k) => (
              <option key={k} value={k}>
                {OWNERSHIP_LABELS[k]}
              </option>
            ))}
            <option value="pending">未分流</option>
          </select>
        </F>
        <F label="週期">
          <select value={form.cadence} onChange={(e) => set("cadence", e.target.value as RecurringCadence)} className={sel}>
            {(Object.keys(CADENCE_LABELS) as RecurringCadence[]).map((k) => (
              <option key={k} value={k}>
                {CADENCE_LABELS[k]}
              </option>
            ))}
          </select>
        </F>
        <F label="起始月份">
          <Input type="month" value={form.startMonth} onChange={(e) => set("startMonth", e.target.value)} className="h-8 text-xs" />
        </F>
        <F label="結束月份(停用才填)">
          <Input type="month" value={form.endMonth} onChange={(e) => set("endMonth", e.target.value)} className="h-8 text-xs" />
        </F>
        <F label="金額模式">
          <select value={form.amountMode} onChange={(e) => set("amountMode", e.target.value as "fixed" | "variable")} className={sel}>
            <option value="variable">依帳單(水電瓦斯)</option>
            <option value="fixed">固定金額(租金、會費)</option>
          </select>
        </F>
        <F label={form.amountMode === "fixed" ? "固定金額(元)" : "參考金額(元,選填)"}>
          <Input inputMode="decimal" value={form.amount} onChange={(e) => set("amount", e.target.value)} className={`h-8 text-xs ${cents === undefined ? "border-destructive" : ""}`} />
        </F>
        <F label="繳費方式">
          <select value={form.paymentMethod} onChange={(e) => set("paymentMethod", e.target.value as "" | PaymentMethod)} className={sel}>
            <option value="">—</option>
            {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((k) => (
              <option key={k} value={k}>
                {PAYMENT_METHOD_LABELS[k]}
              </option>
            ))}
          </select>
        </F>
        <F label="繳費日規則">
          <select value={form.dueRule} onChange={(e) => set("dueRule", e.target.value as "bill" | "next_month_day" | "fixed_day")} className={sel}>
            <option value="bill">依帳單上的繳費期限</option>
            <option value="next_month_day">期末次月 N 日</option>
            <option value="fixed_day">每期期末當月 N 日</option>
          </select>
        </F>
        <F label="N 日(沒有帳單時用來預估,預設 15)">
          <Input type="number" value={form.dueDay} onChange={(e) => set("dueDay", e.target.value)} className="h-8 text-xs" />
        </F>
        <F label="提前幾天提醒">
          <Input type="number" value={form.remindDays} onChange={(e) => set("remindDays", e.target.value)} className="h-8 text-xs" />
        </F>
        <F label="用戶號碼/電號/水號/保單號(可多個,逗號分隔)" wide>
          <Input value={form.accountRefs} onChange={(e) => set("accountRefs", e.target.value)} className="h-8 font-mono text-xs" />
        </F>
        <F label="對帳單摘要關鍵字(逗號分隔,例:台灣電力、台北自來水)" wide>
          <Input value={form.statementKeywords} onChange={(e) => set("statementKeywords", e.target.value)} className="h-8 text-xs" />
        </F>
        <F label="帳單文件" wide>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={!form.needsDocument} onChange={(e) => set("needsDocument", !e.target.checked)} />
            無需帳單(月份檢核不算缺)
          </label>
          <label className="mt-1 flex items-center gap-1.5">
            <input type="checkbox" checked={form.requireProof} onChange={(e) => set("requireProof", e.target.checked)} />
            需要繳款證明(勞保、健保、勞退、稅金:對帳單扣款只算「已扣款、缺證明」,掛上證明才算已繳)
          </label>
        </F>
        <F label='進階:其他比對條件 match_rule(JSON,例:{"vendorTaxId":"03774909","amountTolerance":100,"dateWindowDays":10})' wide>
          <textarea value={form.matchRule} onChange={(e) => set("matchRule", e.target.value)} rows={2} className="w-full border border-input bg-background p-2 font-mono text-[11px]" />
        </F>
        <F label="備註" wide>
          <Input value={form.note} onChange={(e) => set("note", e.target.value)} className="h-8 text-xs" />
        </F>
      </div>
      {error && <div className="mt-3 text-xs text-destructive">{error}</div>}
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button size="sm" disabled={!canSave} onClick={save}>
          儲存
        </Button>
      </div>
    </Drawer>
  );
}

function F({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={`block ${wide ? "col-span-2" : ""}`}>
      <span className="mb-1 block text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function CellDrawer({
  selected,
  onClose,
  onChanged,
}: {
  selected: { series: CoverageSeries; cell: CoverageCell } | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setNote(selected?.cell.note ?? "");
    setError(null);
  }, [selected]);

  async function mark(status: "not_required" | "encrypted" | null) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/recurring/series/${selected.series.id}/marks`, {
        method: "POST",
        body: JSON.stringify({ month: selected.cell.month, status, note: note || null }),
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const cell = selected?.cell;
  const hasDocs = !!cell && (cell.documentIds.length > 0 || cell.reminderDocumentIds.length > 0);
  const markable = !!cell && !hasDocs;

  return (
    <Drawer open={!!selected} onClose={onClose} title={selected ? `${selected.series.name} · ${selected.cell.month}` : ""}>
      {selected && cell && (
        <div className="space-y-4 text-sm">
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center border px-2 py-0.5 text-xs ${STATUS_CLASS[cell.status]}`}>{COVERAGE_STATUS_LABELS[cell.status]}</span>
            {!cell.expected && <span className="text-xs text-muted-foreground">不在這個帳單的應有月份內</span>}
          </div>

          {cell.documentIds.length > 0 && (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">帳單/繳款單</div>
              <DocList ids={cell.documentIds} />
            </div>
          )}
          {cell.reminderDocumentIds.length > 0 && (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">催繳/滯納/行政執行</div>
              <DocList ids={cell.reminderDocumentIds} />
            </div>
          )}

          {markable && (
            <div className="border-t border-line-2 pt-3">
              <div className="mb-2 text-xs text-muted-foreground">這個月沒有文件。可以標記為:</div>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="備註(選填),例如:當月無消費" className="mb-2 h-8 text-xs" />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => mark("not_required")}>
                  無需帳單
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => mark("encrypted")}>
                  只有加密檔
                </Button>
                {(cell.status === "not_required" || cell.status === "encrypted") && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => mark(null)}>
                    取消標記
                  </Button>
                )}
              </div>
            </div>
          )}
          {error && <div className="text-xs text-destructive">{error}</div>}
        </div>
      )}
    </Drawer>
  );
}

function DocList({ ids }: { ids: string[] }) {
  return (
    <ul className="space-y-1">
      {ids.map((id) => (
        <li key={id}>
          <Link href={`/documents?view=document&id=${id}`} className="font-mono text-xs text-primary hover:underline">
            {id}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function RecurringPage() {
  return (
    <Suspense fallback={null}>
      <RecurringRoot />
    </Suspense>
  );
}
