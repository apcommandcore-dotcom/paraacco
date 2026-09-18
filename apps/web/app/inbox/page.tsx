"use client";

// 收件匣(規格 3.5.1)—— 原本是「拖放上傳 + 處理佇列」,2026-09-18 改成純處理監控頁:
// 手動上傳欄位已經拿掉,文件進件改成每天 22:00 自動掃描 Bookkeeper_Scanner 資料夾(見
// apps/api/src/routes/batch-import.ts、Claude Code Remote 排程),這裡只保留佇列狀態顯示。
// 8 步驟進度視覺化進度條(2026-09-17,依 paraacco.dc.html 設計稿的 8 格填色邏輯實作:
// n < currentStage 的格子填色,失敗時最後一格改紅色,不是原本純文字 stageKey(status) 的
// 簡化版——純文字版本在供應商名稱較長時會把整列撐到換行、Pipeline 欄位溢出桌面版表格。

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, AlertTriangle } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { useScope } from "@/components/scope-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch, DOC_STATUS_LABELS, STAGE_LABELS, type DocumentRow } from "@/lib/api";

export default function InboxPage() {
  const router = useRouter();
  const { scope } = useScope();
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 收件匣清單依側邊欄範圍切換器篩選(2026-09-07 補完設計落差任務書任務 2)。
  const loadDocuments = useCallback(async () => {
    try {
      const path = scope ? `/api/documents?ownership=${scope}` : "/api/documents";
      const data = await apiFetch<{ documents: DocumentRow[] }>(path);
      setDocuments(data.documents);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [scope]);

  useEffect(() => {
    loadDocuments();
    // 簡化版輪詢(不是 websocket/SSE)——收件匣頁面停留時每 5 秒重抓一次,足夠看到 pipeline
    // 進度變化,之後如果覆核量大再考慮換成即時推送。
    const timer = setInterval(loadDocuments, 5000);
    return () => clearInterval(timer);
  }, [loadDocuments]);

  // 處理中心頂部統計磚(2026-09-18,對齊 design「paraacco copy-對齊後台copy.dc.html」
  // 處理中心畫面的 IN QUEUE/PROCESSING/FAILED/TODAY 四格)—— 純前端從已經抓回來的
  // documents 陣列算,沒有另外呼叫聚合端點,量體大了再考慮換後端算。
  const stats = useMemo(() => {
    const docs = documents ?? [];
    const today = new Date().toDateString();
    const inQueue = docs.filter((d) => d.status === "queued").length;
    const processing = docs.filter((d) =>
      ["validating", "ocr", "extract", "classifying", "matching", "vendor_check", "retry"].includes(d.status),
    ).length;
    const failed = docs.filter((d) => d.status === "failed").length;
    const archivedToday = docs.filter((d) => d.status === "archived" && new Date(d.createdAt).toDateString() === today).length;
    return { inQueue, processing, failed, archivedToday };
  }, [documents]);

  return (
    <AppShell>
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-wide">處理中心</h1>
        <Button variant="ghost" size="sm" onClick={loadDocuments}>
          <RefreshCw size={14} className="mr-2" />
          重新整理
        </Button>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="排隊中" en="IN QUEUE" value={stats.inQueue} />
        <StatTile label="OCR／擷取中" en="PROCESSING" value={stats.processing} />
        <StatTile label="失敗與等待重試" en="FAILED" value={stats.failed} tone="destructive" />
        <StatTile label="今日已歸檔" en="TODAY" value={stats.archivedToday} tone="success" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>處理佇列</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loadError && (
            <div className="flex items-center gap-2 p-4 text-sm text-destructive">
              <AlertTriangle size={14} />
              讀取文件列表失敗:{loadError}
            </div>
          )}
          {!loadError && documents === null && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
          {!loadError && documents !== null && documents.length === 0 && (
            <div className="p-4 text-sm text-muted-foreground">目前沒有文件。每天 22:00 會自動掃描 Bookkeeper_Scanner 資料夾進件。</div>
          )}
          {!loadError && documents !== null && documents.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>文件</TableHead>
                  <TableHead>供應商</TableHead>
                  <TableHead>金額</TableHead>
                  <TableHead>狀態</TableHead>
                  <TableHead>Pipeline 進度</TableHead>
                  <TableHead>建立時間</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {documents.slice(0, 30).map((doc) => (
                  <TableRow
                    key={doc.id}
                    onClick={() => router.push(`/review?doc=${doc.id}`)}
                    className="cursor-pointer hover:bg-nav-sub"
                  >
                    <TableCell className="whitespace-nowrap font-mono text-xs">{doc.id}</TableCell>
                    <TableCell className="max-w-[180px] truncate">{doc.vendorNameRaw ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {doc.amountCents != null ? `${doc.currency ?? "TWD"} ${(doc.amountCents / 100).toFixed(2)}` : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Badge variant={statusVariant(doc.status)}>{DOC_STATUS_LABELS[doc.status] ?? doc.status}</Badge>
                    </TableCell>
                    <TableCell className="min-w-[160px]">
                      {doc.processingJob ? (
                        <PipelineProgress stage={doc.processingJob.currentStage} status={doc.processingJob.status} />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                      {doc.processingJob?.stageKey && (
                        <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                          {STAGE_LABELS[doc.processingJob.stageKey] ?? doc.processingJob.stageKey}
                        </div>
                      )}
                      {doc.processingJob?.errorMessage && (
                        <div className="mt-1 text-[11px] text-destructive">{doc.processingJob.errorMessage}</div>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(doc.createdAt).toLocaleString("zh-TW")}</TableCell>
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

function statusVariant(status: DocumentRow["status"]): "default" | "warning" | "destructive" | "success" | "outline" {
  if (status === "failed") return "destructive";
  if (status === "review" || status === "retry") return "warning";
  if (status === "archived") return "success";
  return "outline";
}

// 8 格視覺化進度條 —— 對照 paraacco.dc.html 的填色邏輯:格子索引 < currentStage 才填色,
// status 為 failed 時最後一格(currentStage 附近)改紅色標示卡在哪一步,其餘格子維持空白
// 外框,不是一次全部填滿或全部留白。
function StatTile({
  label,
  en,
  value,
  tone,
}: {
  label: string;
  en: string;
  value: number;
  tone?: "destructive" | "success";
}) {
  return (
    <div className="border border-line bg-surface px-4 py-3">
      <div className="font-mono text-[10px] tracking-[0.12em] text-foreground-3">{en}</div>
      <div
        className={`mt-1 text-2xl font-bold ${
          tone === "destructive" && value > 0 ? "text-destructive" : tone === "success" ? "text-ok" : "text-foreground"
        }`}
      >
        {value}
      </div>
      <div className="mt-0.5 text-xs text-foreground-2">{label}</div>
    </div>
  );
}

function PipelineProgress({ stage, status }: { stage: number; status: string }) {
  const failed = status === "failed" || status === "retry";
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: 8 }, (_, n) => {
        const filled = n < stage;
        const isFailingStep = failed && n >= stage - 1 && filled;
        return (
          <span
            key={n}
            className={`h-1.5 flex-1 ${
              isFailingStep ? "bg-destructive" : filled ? "bg-primary" : "border border-border bg-transparent"
            }`}
          />
        );
      })}
    </div>
  );
}
