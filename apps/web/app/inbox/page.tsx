"use client";

// 收件匣(規格 3.5.1)—— Phase 1:拖放上傳 + 處理佇列。8 步驟進度先做簡化版(純文字顯示
// current_stage/stage_key),不做視覺化進度條,見 CODE_TASK_go-live-a2-a3-phase1_20260904.md
// Phase 1 範圍說明。

import { useCallback, useEffect, useRef, useState } from "react";
import { UploadCloud, RefreshCw, AlertTriangle } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch, DOC_STATUS_LABELS, STAGE_LABELS, type DocumentRow } from "@/lib/api";

type OwnershipOption = "per" | "corp" | "advance" | "custody";

const OWNERSHIP_LABELS: Record<OwnershipOption, string> = {
  corp: "公司",
  per: "個人",
  advance: "代墊",
  custody: "代管",
};

interface UploadTask {
  id: string;
  fileName: string;
  status: "uploading" | "registering" | "done" | "error";
  error?: string;
}

export default function InboxPage() {
  const [ownership, setOwnership] = useState<OwnershipOption>("corp");
  const [isDragging, setIsDragging] = useState(false);
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadDocuments = useCallback(async () => {
    try {
      const data = await apiFetch<{ documents: DocumentRow[] }>("/api/documents");
      setDocuments(data.documents);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    loadDocuments();
    // 簡化版輪詢(不是 websocket/SSE)——收件匣頁面停留時每 5 秒重抓一次,足夠看到 pipeline
    // 進度變化,之後如果覆核量大再考慮換成即時推送。
    const timer = setInterval(loadDocuments, 5000);
    return () => clearInterval(timer);
  }, [loadDocuments]);

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        const taskId = crypto.randomUUID();
        setTasks((prev) => [...prev, { id: taskId, fileName: file.name, status: "uploading" }]);
        try {
          const form = new FormData();
          form.append("file", file);
          const uploaded = await apiFetch<{ r2Key: string; fileName: string; mimeType: string; byteSize: number; sha256: string }>(
            "/api/uploads",
            { method: "POST", body: form },
          );

          setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: "registering" } : t)));

          await apiFetch<{ ok: true; id: string }>("/api/documents", {
            method: "POST",
            body: JSON.stringify({
              ownership,
              fileName: uploaded.fileName,
              mimeType: uploaded.mimeType,
              byteSize: uploaded.byteSize,
              r2Key: uploaded.r2Key,
              sha256: uploaded.sha256,
              source: "web_upload",
            }),
          });

          setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: "done" } : t)));
        } catch (err) {
          setTasks((prev) =>
            prev.map((t) => (t.id === taskId ? { ...t, status: "error", error: err instanceof Error ? err.message : String(err) } : t)),
          );
        }
      }
      loadDocuments();
    },
    [ownership, loadDocuments],
  );

  return (
    <AppShell>
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-wide">收件匣</h1>
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
            <p className="text-xs text-muted-foreground">單檔上限 25MB</p>
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
            <ul className="mt-4 space-y-1 text-xs">
              {tasks.map((t) => (
                <li key={t.id} className="flex items-center gap-2">
                  <span className="font-mono text-muted-foreground">
                    {t.status === "uploading" && "上傳中…"}
                    {t.status === "registering" && "登記中…"}
                    {t.status === "done" && "完成"}
                    {t.status === "error" && "失敗"}
                  </span>
                  <span>{t.fileName}</span>
                  {t.error && <span className="text-destructive">{t.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

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
                  <TableRow key={doc.id}>
                    <TableCell className="font-mono text-xs">{doc.id}</TableCell>
                    <TableCell>{doc.vendorNameRaw ?? "—"}</TableCell>
                    <TableCell>{doc.amountCents != null ? `${doc.currency ?? "TWD"} ${(doc.amountCents / 100).toFixed(2)}` : "—"}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(doc.status)}>{DOC_STATUS_LABELS[doc.status] ?? doc.status}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {doc.processingJob
                        ? `${STAGE_LABELS[doc.processingJob.stageKey] ?? doc.processingJob.stageKey}（${doc.processingJob.status}）`
                        : "—"}
                      {doc.processingJob?.errorMessage && (
                        <div className="mt-1 text-destructive">{doc.processingJob.errorMessage}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(doc.createdAt).toLocaleString("zh-TW")}</TableCell>
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
