"use client";

// 對帳頁(架構文件第 6 節新增畫面)—— 列出 statement_lines,標示已勾稽/建議勾稽・待確認/
// 未勾稽三種狀態(綠/黃/紅,沿用既有的 ok/warn/err 語意色,見 ui/badge.tsx 的 success/
// warning/destructive variant,跟 warranty 頁用同一套配色慣例,不是新發明的顏色)。
//
// 比對本身(matched/suggested/unmatched 的判定)由 document-worker 落地明細列時、跟每日
// 排程重新比對時算好(見 apps/api/src/reconciliation.ts),這裡只負責顯示 + 讓人工在
// suggested/unmatched 的列上一鍵確認或修正——呼應架構文件第 6.1 節可點擊原型的互動
// 說明:「點擊建議按鈕直接確認掉,不需要另外按送出」。

import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  apiFetch,
  RECONCILIATION_STATUS_LABELS,
  type EntityRow,
  type ReconciliationStatus,
  type StatementLineRow,
} from "@/lib/api";

function statusVariant(status: ReconciliationStatus): "success" | "warning" | "destructive" {
  if (status === "matched") return "success";
  if (status === "suggested") return "warning";
  return "destructive";
}

function formatAmount(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}NT$${Math.abs(cents / 100).toLocaleString("zh-TW")}`;
}

const STATUS_TABS: { value: ReconciliationStatus | null; label: string }[] = [
  { value: null, label: "全部" },
  { value: "unmatched", label: RECONCILIATION_STATUS_LABELS.unmatched },
  { value: "suggested", label: RECONCILIATION_STATUS_LABELS.suggested },
  { value: "matched", label: RECONCILIATION_STATUS_LABELS.matched },
];

export default function ReconciliationPage() {
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [entityId, setEntityId] = useState<string | null>(null);
  const [status, setStatus] = useState<ReconciliationStatus | null>(null);
  const [lines, setLines] = useState<StatementLineRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    apiFetch<{ entities: EntityRow[] }>("/api/entities")
      .then((d) => setEntities(d.entities))
      .catch(() => {});
  }, []);

  function load() {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (entityId) params.set("entityId", entityId);
    const qs = params.toString();
    apiFetch<{ statementLines: StatementLineRow[] }>(`/api/statement-lines${qs ? `?${qs}` : ""}`)
      .then((d) => setLines(d.statementLines))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(load, [status, entityId]);

  async function confirm(id: number, purchaseId: string | null) {
    setBusyId(id);
    setError(null);
    try {
      await apiFetch(`/api/statement-lines/${id}/confirm`, {
        method: "POST",
        body: JSON.stringify({ purchaseId: purchaseId ?? undefined }),
      });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AppShell>
      <div className="mb-1.5 flex items-baseline gap-2.5">
        <h1 className="m-0 text-[23px] font-extrabold tracking-tight">對帳</h1>
        <span className="font-mono text-[10px] tracking-[0.16em] text-foreground-3">RECONCILIATION</span>
      </div>
      <p className="mb-5 text-sm text-foreground-2">
        對帳單(信用卡/銀行)明細列 × 憑證/採購案自動比對結果,建議勾稽的列可以一鍵確認,不確定的可以標記未勾稽。
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <div className="flex border border-line">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.label}
              type="button"
              onClick={() => setStatus(tab.value)}
              className={`border-r border-line px-3 py-1.5 text-xs last:border-r-0 ${
                status === tab.value ? "bg-brand font-semibold text-on-brand" : "bg-surface text-foreground hover:bg-nav-sub"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <select
          value={entityId ?? ""}
          onChange={(e) => setEntityId(e.target.value || null)}
          className="h-[30px] border border-line bg-surface px-2 text-xs text-foreground"
        >
          <option value="">全部法律主體</option>
          {entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="mb-4 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">{error}</div>}

      <Card>
        <CardContent className="p-0">
          {lines === null && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
          {lines?.length === 0 && <div className="p-4 text-sm text-muted-foreground">目前沒有符合條件的對帳明細列。</div>}
          {lines && lines.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead>摘要</TableHead>
                  <TableHead>金額</TableHead>
                  <TableHead>狀態</TableHead>
                  <TableHead>對應採購案</TableHead>
                  <TableHead>備註</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell className="font-mono text-xs">{line.date}</TableCell>
                    <TableCell>{line.description}</TableCell>
                    <TableCell className="font-mono text-xs">{formatAmount(line.amountCents)}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(line.reconciliationStatus)}>{RECONCILIATION_STATUS_LABELS[line.reconciliationStatus]}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {line.matchedPurchaseId ? (
                        <span>
                          <span className="font-mono">{line.matchedPurchaseId}</span>
                          {line.matchedPurchaseVendor ? ` · ${line.matchedPurchaseVendor}` : ""}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground" title={line.matchNote ?? undefined}>
                      {line.matchNote ?? "—"}
                    </TableCell>
                    <TableCell>
                      {line.reconciliationStatus === "suggested" && line.matchedPurchaseId && (
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            disabled={busyId === line.id}
                            onClick={() => confirm(line.id, line.matchedPurchaseId)}
                            className="flex items-center gap-1 border border-ok-line bg-ok-bg px-2 py-1 text-[11px] text-ok hover:opacity-80 disabled:opacity-50"
                          >
                            <Check size={11} />
                            確認勾稽
                          </button>
                          <button
                            type="button"
                            disabled={busyId === line.id}
                            onClick={() => confirm(line.id, null)}
                            className="flex items-center gap-1 border border-line bg-surface px-2 py-1 text-[11px] text-foreground-2 hover:bg-nav-sub disabled:opacity-50"
                          >
                            <X size={11} />
                            標記未勾稽
                          </button>
                        </div>
                      )}
                      {line.reconciliationStatus === "unmatched" && (
                        <span className="text-[11px] text-foreground-3">等待採購案建立後自動重新比對</span>
                      )}
                    </TableCell>
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
