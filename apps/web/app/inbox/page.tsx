"use client";

// 收件匣(規格 3.5.1)—— 拖放上傳 + 處理佇列。8 步驟進度改成視覺化進度條(2026-09-17,
// 依 paraacco.dc.html 設計稿的 8 格填色邏輯實作:n < currentStage 的格子填色,失敗時最後
// 一格改紅色,不是原本純文字 stageKey(status) 的簡化版——純文字版本在供應商名稱較長時會
// 把整列撐到換行、Pipeline 欄位溢出桌面版表格。
//
// 上傳流程(2026-09-06 改成預簽 URL 直傳 R2,見 CODE_TASK_post-golive-hardening_20260905.md
// 任務 2):POST /api/uploads/presign 拿簽好的 URL → 瀏覽器直接 PUT 到 R2(用 XHR 而不是
// fetch,才能拿到 upload progress 事件)→ sha256 用 Web Crypto 在瀏覽器端算 → POST
// /api/documents 登記文件。失敗可以針對單一檔案重試,不用整批重來。
// 2026-09-10 資產欄位對齊任務書任務 3:上傳邏輯本體抽到 @/lib/upload(資產詳情「新增
// 說明書」共用同一套),這裡改成呼叫共用函式,行為不變。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { UploadCloud, RefreshCw, AlertTriangle, RotateCcw } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { useScope } from "@/components/scope-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch, DOC_STATUS_LABELS, STAGE_LABELS, type DocumentRow } from "@/lib/api";
import { uploadDocument } from "@/lib/upload";

type OwnershipOption = "per" | "corp" | "advance" | "custody";

const OWNERSHIP_LABELS: Record<OwnershipOption, string> = {
  corp: "公司",
  per: "個人",
  advance: "代墊",
  custody: "代管",
};

interface UploadTask {
  id: string;
  file: File;
  status: "uploading" | "registering" | "done" | "error";
  progress: number; // 0-100,只算 R2 上傳這段(登記那次 API call 很快,不特別算進度)
  error?: string;
}

export default function InboxPage() {
  const router = useRouter();
  const { scope } = useScope();
  const [ownership, setOwnership] = useState<OwnershipOption>("corp");
  const [isDragging, setIsDragging] = useState(false);
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 收件匣清單依側邊欄範圍切換器篩選(2026-09-07 補完設計落差任務書任務 2)——跟上傳時
  // 選的 ownership(這個頁面上方的公司/個人/代墊/代管按鈕)是兩件事,那個是「這份文件要標記
  // 成什麼歸屬」,這個是「目前只看哪個範圍的既有文件」。
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

  const runUpload = useCallback(
    async (taskId: string, file: File) => {
      try {
        setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: "uploading", progress: 0, error: undefined } : t)));

        await uploadDocument(file, ownership, {
          onProgress: (pct) => setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, progress: pct } : t))),
          onRegistering: () => setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: "registering" } : t))),
        });

        setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: "done", progress: 100 } : t)));
        loadDocuments();
      } catch (err) {
        setTasks((prev) =>
          prev.map((t) => (t.id === taskId ? { ...t, status: "error", error: err instanceof Error ? err.message : String(err) } : t)),
        );
      }
    },
    [ownership, loadDocuments],
  );

  const uploadFiles = useCallback(
    (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        const taskId = crypto.randomUUID();
        setTasks((prev) => [...prev, { id: taskId, file, status: "uploading", progress: 0 }]);
        runUpload(taskId, file);
      }
    },
    [runUpload],
  );

  function retryTask(task: UploadTask) {
    runUpload(task.id, task.file);
  }

  const pendingCount = tasks.filter((t) => t.status === "uploading" || t.status === "registering").length;
  const overallProgress = tasks.length
    ? Math.round(tasks.reduce((sum, t) => sum + (t.status === "done" ? 100 : t.status === "error" ? 0 : t.progress), 0) / tasks.length)
    : 0;

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

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>上傳單據</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">歸屬</span>
            {(Object.keys(OWNERSHIP_LABELS) as OwnershipOption[]).map((opt) => (
              <button
                key={opt}
                onClick={() => setOwnership(opt)}
                className={`border px-3 py-1 text-xs ${
                  ownership === opt ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground"
                }`}
              >
                {OWNERSHIP_LABELS[opt]}
              </button>
            ))}
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 border-2 border-dashed py-12 text-center transition-colors ${
              isDragging ? "border-primary bg-accent" : "border-border"
            }`}
          >
            <UploadCloud size={28} className="text-muted-foreground" />
            <p className="text-sm">拖放 PDF / 圖片到這裡,或點擊選擇檔案</p>
            <p className="text-xs text-muted-foreground">單檔上限 25MB,直接上傳到 R2</p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="application/pdf,image/*"
              className="hidden"
              onChange={(e) => e.target.files && uploadFiles(e.target.files)}
            />
          </div>

          {tasks.length > 0 && (
            <div className="mt-4 space-y-3">
              {tasks.length > 1 && (
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      整體進度({tasks.length - pendingCount}/{tasks.length} 完成)
                    </span>
                    <span>{overallProgress}%</span>
                  </div>
                  <div className="h-1.5 w-full bg-muted">
                    <div className="h-1.5 bg-primary transition-all" style={{ width: `${overallProgress}%` }} />
                  </div>
                </div>
              )}
              <ul className="space-y-1 text-xs">
                {tasks.map((t) => (
                  <li key={t.id} className="flex items-center gap-2">
                    <span className="w-16 shrink-0 font-mono text-muted-foreground">
                      {t.status === "uploading" && `上傳 ${t.progress}%`}
                      {t.status === "registering" && "登記中…"}
                      {t.status === "done" && "完成"}
                      {t.status === "error" && "失敗"}
                    </span>
                    <span className="truncate">{t.file.name}</span>
                    {t.error && <span className="truncate text-destructive">{t.error}</span>}
                    {t.status === "error" && (
                      <Button variant="ghost" size="sm" onClick={() => retryTask(t)} className="ml-auto shrink-0">
                        <RotateCcw size={12} className="mr-1" />
                        重試
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

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
            <div className="p-4 text-sm text-muted-foreground">目前沒有文件。</div>
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
