"use client";

// 報表(規格 3.4)—— Phase 5:先做一個最基本的「依供應商彙總金額」表,沒有匯出/篩選日期
// 區間等進階功能。跟 Dashboard 一樣,目前在前端對 GET /api/documents 的結果做彙總(沒有
// 後端聚合端點),資料量大了之後要換成後端 SQL GROUP BY。

import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch, type DocumentRow } from "@/lib/api";

export default function ReportsPage() {
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ documents: DocumentRow[] }>("/api/documents")
      .then((d) => setDocuments(d.documents))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const byVendor = useMemo(() => {
    const rows = (documents ?? []).filter((d) => d.status === "archived" && d.amountCents != null);
    const map = new Map<string, { vendor: string; count: number; totalCents: number }>();
    for (const d of rows) {
      const key = d.vendorNameRaw ?? "（未知供應商）";
      const existing = map.get(key) ?? { vendor: key, count: 0, totalCents: 0 };
      existing.count += 1;
      existing.totalCents += d.amountCents ?? 0;
      map.set(key, existing);
    }
    return [...map.values()].sort((a, b) => b.totalCents - a.totalCents);
  }, [documents]);

  return (
    <AppShell>
      <h1 className="mb-6 text-xl font-semibold tracking-wide">報表</h1>
      {error && <div className="mb-4 border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      <Card>
        <CardHeader>
          <CardTitle>依供應商彙總(已歸檔文件)</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {documents === null && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
          {documents !== null && byVendor.length === 0 && <div className="p-4 text-sm text-muted-foreground">還沒有已歸檔的文件。</div>}
          {byVendor.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>供應商</TableHead>
                  <TableHead>筆數</TableHead>
                  <TableHead>總金額</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byVendor.map((row) => (
                  <TableRow key={row.vendor}>
                    <TableCell>{row.vendor}</TableCell>
                    <TableCell className="font-mono text-xs">{row.count}</TableCell>
                    <TableCell className="font-mono text-xs">NT${(row.totalCents / 100).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}
