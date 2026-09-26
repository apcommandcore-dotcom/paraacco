"use client";

// 月報表(2026-09-26 改版,Theo:「原本預期是選擇年月後按報表,將該月份所有項目印出」)——
// 取代原本「依供應商彙總(已歸檔文件)」那張表(內容跟總覽重複)。
//
// - 依「發票/帳單日期」(invoiceDate,沒有才用 docDate)落在所選月份的文件,不是匯入日期。
// - 範圍沿用頂欄的範圍切換器(全部/公司/個人…),另可篩狀態(預設排除「重複」「失敗」)。
// - 小計:依歸屬(公司/個人/代墊/代管)分列,最後總計;退款/折讓為負數照實扣。
// - 「列印」用瀏覽器列印(AppShell 在 print 模式會隱藏頂欄),可另存 PDF。
// - 資料量小,前端對 GET /api/documents 篩選即可;之後量大再改後端依月份查詢。

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Printer } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { useScope } from "@/components/scope-context";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch, DOC_STATUS_LABELS, OWNERSHIP_LABELS, type DocumentRow, type OwnershipScope } from "@/lib/api";

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const nt = (cents: number) => `${cents < 0 ? "−" : ""}NT$${Math.abs(Math.round(cents / 100)).toLocaleString()}`;

type StatusMode = "valid" | "archived" | "all";
const STATUS_MODES: Record<StatusMode, { label: string; test: (s: string) => boolean }> = {
  valid: { label: "全部有效(排除重複、失敗)", test: (s) => s !== "dup" && s !== "failed" },
  archived: { label: "僅已歸檔", test: (s) => s === "archived" },
  all: { label: "全部狀態", test: () => true },
};

function ReportsRoot() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { scope } = useScope();
  const month = /^\d{4}-\d{2}$/.test(searchParams.get("month") ?? "") ? searchParams.get("month")! : currentMonth();
  const [statusMode, setStatusMode] = useState<StatusMode>("valid");
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDocuments(null);
    apiFetch<{ documents: DocumentRow[] }>(scope ? `/api/documents?ownership=${scope}` : "/api/documents")
      .then((d) => setDocuments(d.documents))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [scope]);

  const setMonth = (m: string) => router.replace(`/reports?month=${m}`);

  const rows = useMemo(
    () =>
      (documents ?? [])
        .filter((d) => (d.invoiceDate ?? d.docDate ?? "").startsWith(month) && STATUS_MODES[statusMode].test(d.status))
        .sort((a, b) => (a.invoiceDate ?? a.docDate ?? "").localeCompare(b.invoiceDate ?? b.docDate ?? "") || a.id.localeCompare(b.id)),
    [documents, month, statusMode],
  );
  const noDate = (documents ?? []).filter((d) => !d.invoiceDate && !d.docDate && STATUS_MODES[statusMode].test(d.status)).length;

  const subtotals = useMemo(() => {
    const map = new Map<string, { count: number; cents: number }>();
    for (const d of rows) {
      const cur = map.get(d.ownership) ?? { count: 0, cents: 0 };
      cur.count += 1;
      cur.cents += d.amountCents ?? 0;
      map.set(d.ownership, cur);
    }
    return [...map.entries()];
  }, [rows]);
  const total = rows.reduce((s, d) => s + (d.amountCents ?? 0), 0);
  const missingAmount = rows.filter((d) => d.amountCents == null).length;
  const [y, m] = month.split("-");

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
          <input
            type="month"
            value={month}
            onChange={(e) => e.target.value && setMonth(e.target.value)}
            className="h-9 border border-input bg-background px-2 font-mono text-sm"
          />
          <Button size="sm" variant="outline" onClick={() => setMonth(shiftMonth(month, 1))}>
            下月 ›
          </Button>
          <select
            value={statusMode}
            onChange={(e) => setStatusMode(e.target.value as StatusMode)}
            className="h-9 border border-input bg-background px-2 text-sm"
          >
            {(Object.keys(STATUS_MODES) as StatusMode[]).map((k) => (
              <option key={k} value={k}>
                {STATUS_MODES[k].label}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={() => window.print()} disabled={!rows.length}>
            <Printer size={14} className="mr-1" />
            列印/存 PDF
          </Button>
        </div>
      </div>

      {error && <div className="mb-4 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">{error}</div>}

      <div className="border border-line bg-surface p-5 print:border-0 print:p-0">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="m-0 text-lg font-bold">
            Atelier Parallel 單據月報表 — {y} 年 {Number(m)} 月
          </h2>
          <span className="text-xs text-foreground-3">
            範圍:{scope ? OWNERSHIP_LABELS[scope as OwnershipScope] : "全部"}・{STATUS_MODES[statusMode].label}・依發票/帳單日期・列印時間{" "}
            {new Date().toLocaleString("zh-TW")}
          </span>
        </div>

        {documents === null && <div className="text-sm text-muted-foreground">載入中…</div>}
        {documents !== null && rows.length === 0 && <div className="text-sm text-muted-foreground">這個月份沒有單據。</div>}

        {rows.length > 0 && (
          <>
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>日期</TableHead>
                  <TableHead>供應商</TableHead>
                  <TableHead>發票號碼</TableHead>
                  <TableHead>歸屬</TableHead>
                  <TableHead>狀態</TableHead>
                  <TableHead className="text-right">金額</TableHead>
                  <TableHead className="print:hidden">文件</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((d, i) => (
                  <TableRow key={d.id} className="break-inside-avoid">
                    <TableCell className="font-mono text-foreground-3">{i + 1}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono">{d.invoiceDate ?? d.docDate}</TableCell>
                    <TableCell className="max-w-[280px]">{d.vendorNameRaw ?? d.displayName ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono">{d.invoiceNo ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">{OWNERSHIP_LABELS[d.ownership as OwnershipScope] ?? d.ownership}</TableCell>
                    <TableCell className="whitespace-nowrap">{DOC_STATUS_LABELS[d.status] ?? d.status}</TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono">{d.amountCents != null ? nt(d.amountCents) : "—"}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-[10px] text-foreground-3 print:hidden">
                      <button type="button" className="hover:underline" onClick={() => router.push(`/documents?view=document&id=${d.id}`)}>
                        {d.id}
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="mt-4 flex justify-end">
              <table className="text-sm">
                <tbody>
                  {subtotals.map(([own, v]) => (
                    <tr key={own}>
                      <td className="pr-6 text-foreground-2">
                        {OWNERSHIP_LABELS[own as OwnershipScope] ?? own} 小計({v.count} 筆)
                      </td>
                      <td className="text-right font-mono">{nt(v.cents)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-border font-bold">
                    <td className="pr-6 pt-1">總計({rows.length} 筆)</td>
                    <td className="pt-1 text-right font-mono">{nt(total)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}

        {(missingAmount > 0 || noDate > 0) && (
          <p className="mt-4 text-xs text-foreground-3">
            {missingAmount > 0 && `本月有 ${missingAmount} 筆沒有金額(未計入總計)。`}
            {noDate > 0 && `另有 ${noDate} 筆單據沒有發票/帳單日期,不在任何月份的報表裡,請到處理中心補日期。`}
          </p>
        )}
      </div>
    </AppShell>
  );
}

export default function ReportsPage() {
  return (
    <Suspense fallback={null}>
      <ReportsRoot />
    </Suspense>
  );
}
