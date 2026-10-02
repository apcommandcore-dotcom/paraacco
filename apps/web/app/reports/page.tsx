"use client";

// 月報表(2026-09-26 改版:選年月、依發票/帳單日期列出該月所有項目)。
//
// 2026-09-29 改成以「物件」為一列(CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md 2.1、5.2),並分
// 「定期繳費/一般消費」兩段(CODE_TASK_recurring-bills-single-page_20260929_V1.01.md 2.4)。資料改由
// GET /api/reports/monthly 在後端組好(@paraacco/domain buildMonthlyReport):
// - 每個物件一列,顯示主文件(發票)的日期/供應商/發票號/歸屬/金額;附件(出貨單、收據、說明書、影片…)不計金額,
//   只在「附件」欄摘要。還沒合併的單獨文件視為只有一份文件的物件。
// - 物件主文件掛了定期繳費項目 → 「定期繳費」段,其餘 → 「一般消費」段;兩段各自小計,總計照舊。
// - 品項可展開/收合(預設收合,「全部展開/全部收合」記在瀏覽器);混合歸屬時公司/個人小計依品項拆分。
// - 截止日(系統設定,預設 2026-10-01)之後開立、被設成混合歸屬的發票列入「待確認」。
// - 「列印/存 PDF」與「匯出 CSV」都跟著目前的展開/收合狀態。

import { Fragment, Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Download, Printer } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { ExpandAllToggle, ExpandButton, useExpandState } from "@/components/expand-state";
import { useScope } from "@/components/scope-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { centsToNumber, formatCents } from "@/lib/format";
import { ItemContextMenu, ItemMenuButton, ItemTags, useItemMenu, useItemMenuData } from "@/components/item-menu";
import {
  apiFetch,
  DOC_STATUS_LABELS,
  OWNERSHIP_LABELS,
  type DocumentStatus,
  type MonthlyReportResponse,
  type OwnershipScope,
  type ReportRow,
  type PurchaseItemRow,
  type ReportSubtotals,
  UNCATEGORIZED_KEY,
} from "@/lib/api";

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const nt = (cents: number) => formatCents(cents, { round: true });
const ownLabel = (o: string) => OWNERSHIP_LABELS[o as OwnershipScope] ?? o;

type StatusMode = "valid" | "archived" | "all";
const STATUS_MODES: Record<StatusMode, string> = {
  valid: "全部有效(排除重複、失敗、略過)",
  archived: "僅已歸檔",
  all: "全部狀態",
};

function ReportsRoot() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { scope } = useScope();
  const month = /^\d{4}-\d{2}$/.test(searchParams.get("month") ?? "") ? searchParams.get("month")! : currentMonth();
  const [statusMode, setStatusMode] = useState<StatusMode>("valid");
  const [report, setReport] = useState<MonthlyReportResponse | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const expand = useExpandState("reports");
  // 列印時間只在瀏覽器端算(伺服器預先渲染的時間跟瀏覽器差幾秒會造成 hydration 不一致)。
  const [printedAt, setPrintedAt] = useState("");
  useEffect(() => setPrintedAt(new Date().toLocaleString("zh-TW")), [report]);

  useEffect(() => {
    setReport(null);
    setError(null);
    const q = new URLSearchParams({ month, status: statusMode });
    if (scope) q.set("ownership", scope);
    apiFetch<MonthlyReportResponse>(`/api/reports/monthly?${q}`)
      .then(setReport)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [month, statusMode, scope, reloadKey]);

  const setMonth = (m: string) => router.replace(`/reports?month=${m}`);
  const [y, m] = month.split("-");
  const rowCount = report ? report.recurring.rows.length + report.general.rows.length : 0;
  const pending = useMemo(() => (report ? [...report.general.rows, ...report.recurring.rows].filter((r) => r.needsConfirm) : []), [report]);

  function exportCsv() {
    if (!report) return;
    const esc = (v: unknown) => {
      const t = String(v ?? "");
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const lines = [["段落", "列別", "日期", "供應商/品名", "發票號碼", "歸屬", "狀態", "數量", "金額(元)", "附件", "物件/文件", "註記"].join(",")];
    for (const [segLabel, seg] of [
      ["定期繳費", report.recurring],
      ["一般消費", report.general],
    ] as const) {
      for (const r of seg.rows) {
        const flags = [r.itemAmountMismatch && "品項金額不符", r.mixedOwnership && "混合歸屬", r.needsConfirm && "待確認"].filter(Boolean).join("/");
        lines.push(
          [
            segLabel,
            "物件",
            r.date,
            r.vendor,
            r.invoiceNo,
            ownLabel(r.ownership),
            DOC_STATUS_LABELS[r.status as DocumentStatus] ?? r.status,
            "",
            r.amountCents != null ? centsToNumber(r.amountCents) : "",
            r.attachmentSummary,
            r.purchaseId ?? r.primaryDocumentId,
            flags,
          ]
            .map(esc)
            .join(","),
        );
        if (expand.isExpanded(r.key)) {
          for (const it of r.items) {
            lines.push([segLabel, "品項", "", `  ${it.name}`, "", ownLabel(it.effectiveOwnership), "", it.quantity, centsToNumber(it.amountCents), it.attachmentCount || "", it.id, ""].map(esc).join(","));
          }
        }
      }
      lines.push([segLabel, "小計", "", "", "", "", "", "", centsToNumber(seg.subtotals.cents), "", `${seg.subtotals.count} 筆`, ""].map(esc).join(","));
    }
    lines.push(["", "總計", "", "", "", "", "", "", centsToNumber(report.total.cents), "", `${report.total.count} 筆`, ""].map(esc).join(","));
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `月報表_${month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <AppShell>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex items-baseline gap-2.5">
          <h1 className="m-0 text-[23px] font-extrabold tracking-tight">月報表</h1>
          <span className="font-mono text-[10px] tracking-[0.16em] text-foreground-3">MONTHLY REPORT</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setMonth(shiftMonth(month, -1))}>
            ‹ 上月
          </Button>
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="h-9 border border-input bg-background px-2 font-mono text-sm" />
          <Button size="sm" variant="outline" onClick={() => setMonth(shiftMonth(month, 1))}>
            下月 ›
          </Button>
          <select value={statusMode} onChange={(e) => setStatusMode(e.target.value as StatusMode)} className="h-9 border border-input bg-background px-2 text-sm">
            {(Object.keys(STATUS_MODES) as StatusMode[]).map((k) => (
              <option key={k} value={k}>
                {STATUS_MODES[k]}
              </option>
            ))}
          </select>
          <ExpandAllToggle value={expand.allExpanded} onChange={expand.setAllExpanded} />
          <Button size="sm" variant="outline" onClick={exportCsv} disabled={!rowCount}>
            <Download size={14} className="mr-1" />
            匯出 CSV
          </Button>
          <Button size="sm" onClick={() => window.print()} disabled={!rowCount}>
            <Printer size={14} className="mr-1" />
            列印/存 PDF
          </Button>
        </div>
      </div>

      {error && <div className="mb-4 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">{error}</div>}

      <div className="border border-line bg-card p-5 print:border-0 print:p-0">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="m-0 text-lg font-bold">
            Atelier Parallel 單據月報表 — {y} 年 {Number(m)} 月
          </h2>
          <span className="text-xs text-foreground-3">
            範圍:{scope ? ownLabel(scope) : "全部"}・{STATUS_MODES[statusMode]}・依發票/帳單日期・以物件為單位・列印時間 {printedAt}
          </span>
        </div>

        {report === null && !error && <div className="text-sm text-muted-foreground">載入中…</div>}
        {report && rowCount === 0 && <div className="text-sm text-muted-foreground">這個月份沒有單據。</div>}

        {report && rowCount > 0 && (
          <>
            <Segment title="定期繳費" rows={report.recurring.rows} subtotals={report.recurring.subtotals} expand={expand} onOpen={(id) => router.push(`/documents?view=document&id=${id}`)} onItemsChanged={() => setReloadKey((k) => k + 1)} />
            <Segment title="一般消費" rows={report.general.rows} subtotals={report.general.subtotals} expand={expand} onOpen={(id) => router.push(`/documents?view=document&id=${id}`)} onItemsChanged={() => setReloadKey((k) => k + 1)} />

            <div className="mt-4 flex justify-end">
              <table className="text-sm">
                <tbody>
                  {Object.entries(report.total.byOwnership).map(([own, v]) => (
                    <tr key={own}>
                      <td className="pr-6 text-foreground-2">
                        {ownLabel(own)} 小計({v.count} 筆)
                      </td>
                      <td className="text-right font-mono">{nt(v.cents)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-border font-bold">
                    <td className="pr-6 pt-1">總計({report.total.count} 筆)</td>
                    <td className="pt-1 text-right font-mono">{nt(report.total.cents)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <ItemBreakdown report={report} />

            {pending.length > 0 && (
              <div className="mt-4 border border-warning-line bg-warning-bg p-3 text-xs">
                <div className="mb-1 font-semibold text-warning">
                  待確認({pending.length})——{report.cutoff} 之後開立、設成混合歸屬的發票(專案/公司使用應單獨開發票)
                </div>
                <ul className="list-disc pl-4">
                  {pending.map((r) => (
                    <li key={r.key}>
                      {r.date} {r.vendor} {r.invoiceNo ?? ""} {r.amountCents != null ? nt(r.amountCents) : ""}(
                      {Object.entries(r.ownershipSplit)
                        .map(([o, c]) => `${ownLabel(o)} ${nt(c)}`)
                        .join("、")}
                      )
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {report && (report.missingAmount > 0 || report.noDate > 0) && (
          <p className="mt-4 text-xs text-foreground-3">
            {report.missingAmount > 0 && `本月有 ${report.missingAmount} 筆沒有金額(未計入總計)。`}
            {report.noDate > 0 && `另有 ${report.noDate} 筆單據沒有發票/帳單日期,不在任何月份的報表裡,請到處理中心補日期。`}
          </p>
        )}
      </div>
    </AppShell>
  );
}

function Segment({
  title,
  rows,
  subtotals,
  expand,
  onOpen,
  onItemsChanged,
}: {
  title: string;
  rows: ReportRow[];
  subtotals: ReportSubtotals;
  expand: ReturnType<typeof useExpandState>;
  onOpen: (documentId: string) => void;
  onItemsChanged: () => void;
}) {
  // V1.02 7.2:報表展開後的品項列也可以按右鍵(或「⋯」)設類別/專案/代墊/不列帳
  const menu = useItemMenu();
  const menuData = useItemMenuData();
  return (
    <section className="mb-5">
      <h3 className="mb-1.5 flex items-baseline gap-2 text-sm font-bold">
        {title}
        <span className="font-mono text-xs font-normal text-foreground-3">
          {subtotals.count} 筆・{nt(subtotals.cents)}
        </span>
      </h3>
      {rows.length === 0 ? (
        <div className="border border-dashed border-line px-3 py-2 text-xs text-foreground-3">這個月份沒有{title}。</div>
      ) : (
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className="w-6 print:hidden" />
              <TableHead className="w-10">#</TableHead>
              <TableHead>日期</TableHead>
              <TableHead>供應商</TableHead>
              <TableHead>發票號碼</TableHead>
              <TableHead>歸屬</TableHead>
              <TableHead>狀態</TableHead>
              <TableHead className="text-right">金額</TableHead>
              <TableHead>附件</TableHead>
              <TableHead className="print:hidden">物件/文件</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => {
              const open = expand.isExpanded(r.key);
              return (
                <Fragment key={r.key}>
                  <TableRow className="break-inside-avoid">
                    <TableCell className="print:hidden">
                      <ExpandButton expanded={open} onClick={() => expand.toggle(r.key)} count={r.items.length} />
                    </TableCell>
                    <TableCell className="font-mono text-foreground-3">{i + 1}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono">{r.date}</TableCell>
                    <TableCell className="max-w-[280px]">
                      <span className={r.vendorRegistered ? "" : "text-foreground-3"} title={r.vendorRegistered ? undefined : "供應商未建檔,顯示 OCR 店名"}>
                        {r.vendor}
                      </span>
                      <span className="ml-1.5 inline-flex flex-wrap gap-1 align-middle">
                        {r.items.length > 0 && <span className="text-[10px] text-foreground-3">品項 {r.items.length}</span>}
                        {r.itemAmountMismatch && <Badge variant="warning">品項金額不符</Badge>}
                        {r.mixedOwnership && <Badge variant={r.needsConfirm ? "destructive" : "info"}>混合歸屬</Badge>}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono">{r.invoiceNo ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {ownLabel(r.ownership)}
                      {r.mixedOwnership && (
                        <div className="text-[10px] text-foreground-3">
                          {Object.entries(r.ownershipSplit)
                            .map(([o, c]) => `${ownLabel(o)} ${nt(c)}`)
                            .join("・")}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{DOC_STATUS_LABELS[r.status as DocumentStatus] ?? r.status}</TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono">{r.amountCents != null ? nt(r.amountCents) : "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-foreground-2">{r.attachmentSummary || "—"}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-[10px] text-foreground-3 print:hidden">
                      <button type="button" className="hover:underline" onClick={() => onOpen(r.primaryDocumentId)}>
                        {r.purchaseId ?? r.primaryDocumentId}
                      </button>
                    </TableCell>
                  </TableRow>
                  {open &&
                    r.items.map((it) => (
                      <TableRow
                        key={it.id}
                        className={`break-inside-avoid bg-muted ${it.excludeFromReport ? "text-foreground-3 line-through" : ""}`}
                        onContextMenu={(e) => menu.open([it as unknown as PurchaseItemRow], e)}
                      >
                        <TableCell className="print:hidden" />
                        <TableCell />
                        <TableCell />
                        <TableCell className="pl-5 text-foreground-2" colSpan={2}>
                          └ {it.name}
                          <span className="ml-1.5 font-mono text-[10px] text-foreground-3">
                            ×{it.quantity}
                            {it.unitPriceCents != null ? ` @${nt(it.unitPriceCents)}` : ""}
                          </span>
                          <ItemTags item={it as unknown as PurchaseItemRow} data={menuData.data} />
                          <span className="print:hidden">
                            <ItemMenuButton onOpen={(e) => menu.open([it as unknown as PurchaseItemRow], e)} />
                          </span>
                        </TableCell>
                        <TableCell className={`whitespace-nowrap ${it.ownership ? "font-semibold" : "text-foreground-3"}`}>{ownLabel(it.effectiveOwnership)}</TableCell>
                        <TableCell />
                        <TableCell className="whitespace-nowrap text-right font-mono text-foreground-2">{nt(it.amountCents)}</TableCell>
                        <TableCell className="text-foreground-3">{it.attachmentCount ? `附件 ${it.attachmentCount}` : ""}</TableCell>
                        <TableCell className="print:hidden" />
                      </TableRow>
                    ))}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}
      {menu.target && (
        <ItemContextMenu
          target={menu.target}
          data={menuData.data}
          onClose={menu.close}
          onApplied={() => {
            menuData.reload();
            onItemsChanged();
          }}
        />
      )}
      <div className="mt-1.5 flex flex-wrap justify-end gap-x-6 gap-y-1 text-xs">
        {Object.entries(subtotals.byOwnership).map(([own, v]) => (
          <span key={own} className="text-foreground-2">
            {ownLabel(own)} <span className="font-mono">{nt(v.cents)}</span>
          </span>
        ))}
        <span className="font-semibold">
          {title}小計 <span className="font-mono">{nt(subtotals.cents)}</span>
        </span>
      </div>
    </section>
  );
}

export default function ReportsPage() {
  return (
    <Suspense fallback={null}>
      <ReportsRoot />
    </Suspense>
  );
}

/** V1.02 7.5:依費用類別、專案小計(加總 = 總計;沒分類的品項與「發票總額 − 品項加總」的差額歸「未分類」),代墊與不列帳分列。 */
function ItemBreakdown({ report }: { report: MonthlyReportResponse }) {
  const byCategory = Object.entries(report.byCategory ?? {}).sort((a, b) => b[1] - a[1]);
  const byProject = Object.entries(report.byProject ?? {}).sort((a, b) => b[1] - a[1]);
  const advance = report.advanceItems ?? [];
  const excluded = report.excludedItems ?? [];
  const catLabel = (k: string) => (k === UNCATEGORIZED_KEY ? "未分類" : (report.categoryNames?.[k] ?? k));
  const projLabel = (k: string) => (k === UNCATEGORIZED_KEY ? "不屬於專案" : k);
  const payeeLabel = (k: string | null | undefined) => (k ? (report.payeeNames?.[k] ?? k) : "—");
  if (!byCategory.length && !advance.length && !excluded.length) return null;
  const Sub = ({ title, rows, label }: { title: string; rows: Array<[string, number]>; label: (k: string) => string }) => (
    <div>
      <div className="mb-1 font-semibold">{title}</div>
      <table className="text-xs">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className={`pr-6 ${k === UNCATEGORIZED_KEY ? "text-foreground-3" : ""}`}>{label(k)}</td>
              <td className="text-right font-mono">{nt(v)}</td>
            </tr>
          ))}
          <tr className="border-t border-border">
            <td className="pr-6 pt-0.5 text-foreground-3">合計</td>
            <td className="pt-0.5 text-right font-mono">{nt(rows.reduce((s, [, v]) => s + v, 0))}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
  return (
    <div className="mt-6 space-y-4 border-t border-border pt-4 text-xs">
      <div className="flex flex-wrap gap-10">
        <Sub title="依費用類別" rows={byCategory} label={catLabel} />
        <Sub title="依專案" rows={byProject} label={projLabel} />
      </div>
      {advance.length > 0 && (
        <div>
          <div className="mb-1 font-semibold">代墊(待請款,{advance.length} 項,{nt(advance.reduce((s, i) => s + i.amountCents, 0))})</div>
          <ul className="list-disc pl-4">
            {advance.map((i) => (
              <li key={i.itemId}>
                {i.date} {i.vendor}「{i.name}」{nt(i.amountCents)} → {payeeLabel(i.advancePayee)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {excluded.length > 0 && (
        <div>
          <div className="mb-1 font-semibold text-foreground-3">不列帳(未計入上方金額,{excluded.length} 項,{nt(excluded.reduce((s, i) => s + i.amountCents, 0))})</div>
          <ul className="list-disc pl-4 text-foreground-3">
            {excluded.map((i) => (
              <li key={i.itemId}>
                {i.date} {i.vendor}「{i.name}」{nt(i.amountCents)}——{i.reason ?? "未填原因"}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
