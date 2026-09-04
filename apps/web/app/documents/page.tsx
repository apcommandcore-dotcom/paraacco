"use client";

// 文件列表 + 詳情 Drawer(規格 3.2、3.3)—— Phase 3:先做「依文件」這個最基本的 view,
// 依購買案/依資產兩種 view 之後補(見 CODE_TASK_go-live-a2-a3-phase1_20260904.md Phase 3
// 範圍說明)。Drawer 用 client state + URL search param(?doc=)控制開關,不用 parallel
// routes——量體還小,之後真的有需要再升級。

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Drawer } from "@/components/ui/drawer";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  apiFetch,
  DOC_STATUS_LABELS,
  STAGE_LABELS,
  type DocumentRow,
  type ExtractedField,
  type DocumentFile,
} from "@/lib/api";

interface LinkRow {
  id: number;
  relationKind: string;
  linkedBy: string;
  confidenceScore: number | null;
}

interface DocumentDetail {
  document: DocumentRow;
  fields: ExtractedField[];
  files: DocumentFile[];
  purchaseLinks: (LinkRow & { purchaseId: string })[];
  assetLinks: (LinkRow & { assetId: string })[];
}

function statusVariant(status: DocumentRow["status"]): "default" | "warning" | "destructive" | "success" | "outline" {
  if (status === "failed") return "destructive";
  if (status === "review" || status === "retry") return "warning";
  if (status === "archived") return "success";
  return "outline";
}

function DocumentsList() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("doc");

  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const path = statusFilter ? `/api/documents?status=${statusFilter}` : "/api/documents";
      const data = await apiFetch<{ documents: DocumentRow[] }>(path);
      setDocuments(data.documents);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    apiFetch<DocumentDetail>(`/api/documents/${selectedId}`)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [selectedId]);

  const filtered = (documents ?? []).filter((doc) => {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return (
      doc.id.toLowerCase().includes(q) ||
      (doc.vendorNameRaw ?? "").toLowerCase().includes(q) ||
      (doc.invoiceNo ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <AppShell>
      <h1 className="mb-6 text-xl font-semibold tracking-wide">文件</h1>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-64">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜尋文件編號 / 供應商 / 發票號碼" className="pl-8" />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 border border-input bg-background px-3 text-sm"
        >
          <option value="">全部狀態</option>
          {Object.entries(DOC_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="mb-4 border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      <Card>
        <CardContent className="p-0">
          {documents === null && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
          {documents !== null && filtered.length === 0 && <div className="p-4 text-sm text-muted-foreground">沒有符合的文件。</div>}
          {filtered.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>文件</TableHead>
                  <TableHead>供應商</TableHead>
                  <TableHead>發票號碼</TableHead>
                  <TableHead>金額</TableHead>
                  <TableHead>狀態</TableHead>
                  <TableHead>建立時間</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((doc) => (
                  <TableRow key={doc.id} className="cursor-pointer" onClick={() => router.push(`/documents?doc=${doc.id}`)}>
                    <TableCell className="font-mono text-xs">{doc.id}</TableCell>
                    <TableCell>{doc.vendorNameRaw ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{doc.invoiceNo ?? "—"}</TableCell>
                    <TableCell>{doc.amountCents != null ? `${doc.currency ?? "TWD"} ${(doc.amountCents / 100).toFixed(2)}` : "—"}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(doc.status)}>{DOC_STATUS_LABELS[doc.status] ?? doc.status}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(doc.createdAt).toLocaleString("zh-TW")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Drawer open={!!selectedId} onClose={() => router.push("/documents")} title={detail?.document.id ?? "載入中…"}>
        {detail && (
          <div className="space-y-6 text-sm">
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">狀態</h3>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={statusVariant(detail.document.status)}>{DOC_STATUS_LABELS[detail.document.status]}</Badge>
                {detail.document.processingJob && (
                  <span className="font-mono text-xs text-muted-foreground">
                    {STAGE_LABELS[detail.document.processingJob.stageKey] ?? detail.document.processingJob.stageKey}
                  </span>
                )}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">擷取欄位</h3>
              <table className="w-full">
                <tbody>
                  {detail.fields.map((f) => (
                    <tr key={f.id} className="border-b border-border last:border-0">
                      <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">{f.label}</td>
                      <td className="py-1.5">{f.value ?? "—"}</td>
                    </tr>
                  ))}
                  {detail.fields.length === 0 && (
                    <tr>
                      <td className="py-2 text-xs text-muted-foreground">沒有擷取到欄位。</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">檔案</h3>
              <ul className="space-y-1">
                {detail.files.map((f) => (
                  <li key={f.id} className="flex items-center justify-between text-xs">
                    <span>
                      {f.kind}・{f.originalFileName}
                    </span>
                    <span className="text-muted-foreground">{(f.byteSize / 1024).toFixed(0)} KB</span>
                  </li>
                ))}
              </ul>
            </section>

            {(detail.purchaseLinks.length > 0 || detail.assetLinks.length > 0) && (
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">關聯</h3>
                <ul className="space-y-1 text-xs">
                  {detail.purchaseLinks.map((l) => (
                    <li key={`p-${l.id}`}>採購案 {l.purchaseId}({l.relationKind}・{l.linkedBy}）</li>
                  ))}
                  {detail.assetLinks.map((l) => (
                    <li key={`a-${l.id}`}>資產 {l.assetId}({l.relationKind}・{l.linkedBy}）</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </Drawer>
    </AppShell>
  );
}

export default function DocumentsPage() {
  return (
    <Suspense fallback={null}>
      <DocumentsList />
    </Suspense>
  );
}
