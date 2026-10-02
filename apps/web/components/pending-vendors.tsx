"use client";

// 處理中心「待建檔供應商」(2026-09-29,CODE_TASK_vendor-name-from-taxid_20260929.md R-V3)——
// 統編有效但主檔沒有的文件依統編彙總(同一統編一行,方便一次建檔),點統編直接到新增供應商畫面並帶入統編。
// 這些文件不歸檔、不改名;建檔後 API 自動補上 vendorId(R-V4),下一次 archive.py 用主檔名稱歸檔。
// 另列「統編無法辨識」的文件(讀不到或檢查碼錯誤),需要人工看票面補統編。

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch, VENDOR_TAX_ID_SOURCE_LABELS, type PendingVendorsResponse } from "@/lib/api";
import { formatCents } from "@/lib/format";

const nt = (cents: number) => formatCents(cents, { round: true });

export function PendingVendors({ onCount }: { onCount?: (n: number) => void }) {
  const [data, setData] = useState<PendingVendorsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showUnreadable, setShowUnreadable] = useState(false);

  useEffect(() => {
    apiFetch<PendingVendorsResponse>("/api/vendors/pending")
      .then((d) => {
        setData(d);
        onCount?.(d.pending.length);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>待建檔供應商{data ? `(${data.pending.length} 個統編)` : ""}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <p className="px-4 pb-3 text-xs text-muted-foreground">
            這些單據的賣方統編還沒建檔,所以不歸檔、不改名。點統編到「管理 → 供應商與分類」新增(統編自動帶入),建檔後會自動對應並在下次歸檔時用主檔名稱命名。店名是 OCR 讀到的,僅供參考。
          </p>
          {error && <div className="p-4 text-sm text-destructive">{error}</div>}
          {!error && data === null && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
          {data && data.pending.length === 0 && <div className="p-4 text-sm text-muted-foreground">沒有待建檔的供應商。</div>}
          {data && data.pending.length > 0 && (
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead>賣方統編</TableHead>
                  <TableHead>來源</TableHead>
                  <TableHead>OCR 店名(僅供參考)</TableHead>
                  <TableHead className="text-right">單據數</TableHead>
                  <TableHead>日期範圍</TableHead>
                  <TableHead className="text-right">合計</TableHead>
                  <TableHead>文件</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.pending.map((g) => (
                  <TableRow key={g.taxId}>
                    <TableCell className="whitespace-nowrap font-mono">
                      <Link href={`/admin/vendors?taxId=${g.taxId}`} className="text-primary hover:underline" title="到新增供應商畫面(自動帶入統編)">
                        {g.taxId}
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{g.sources.map((s) => VENDOR_TAX_ID_SOURCE_LABELS[s]).join("/")}</TableCell>
                    <TableCell className="max-w-[220px] truncate" title={g.ocrNames.join("、")}>
                      {g.ocrNames.join("、") || "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono">{g.documentCount}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono">{g.dateFrom ? `${g.dateFrom}~${g.dateTo}` : "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono">{nt(g.totalCents)}</TableCell>
                    <TableCell className="max-w-[260px]">
                      <div className="flex flex-wrap gap-x-2 font-mono text-[10px]">
                        {g.documentIds.slice(0, 6).map((id) => (
                          <Link key={id} href={`/review?doc=${id}`} className="text-foreground-3 hover:underline">
                            {id.slice(-6)}
                          </Link>
                        ))}
                        {g.documentIds.length > 6 && <span className="text-foreground-3">…共 {g.documentIds.length} 份</span>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {data && data.unreadable.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              <button type="button" onClick={() => setShowUnreadable((v) => !v)} className="hover:underline">
                統編無法辨識({data.unreadable.length} 份){showUnreadable ? " ▾" : " ▸"}
              </button>
            </CardTitle>
          </CardHeader>
          {showUnreadable && (
            <CardContent className="p-0">
              <p className="px-4 pb-3 text-xs text-muted-foreground">讀不到賣方統編或檢查碼錯誤(收據、國外帳單等)。這類單據的後續規則待定,目前維持原樣。</p>
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead>文件</TableHead>
                    <TableHead>讀到的統編</TableHead>
                    <TableHead>OCR 店名</TableHead>
                    <TableHead>日期</TableHead>
                    <TableHead className="text-right">金額</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.unreadable.map((u) => (
                    <TableRow key={u.documentId}>
                      <TableCell className="whitespace-nowrap font-mono">
                        <Link href={`/review?doc=${u.documentId}`} className="text-primary hover:underline">
                          {u.documentId}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono">{u.rawTaxId ?? "—"}</TableCell>
                      <TableCell className="max-w-[240px] truncate">{u.ocrName ?? "—"}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono">{u.date ?? "—"}</TableCell>
                      <TableCell className="whitespace-nowrap text-right font-mono">{u.amountCents != null ? nt(u.amountCents) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}
