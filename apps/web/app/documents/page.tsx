"use client";

// 文件列表 + 詳情 Drawer(規格 3.2、3.3)—— 三種 view(依文件/依購買案/依資產)切換,
// 沿用同一套 Drawer 詳情互動模式。依購買案/依資產的 Drawer 目前只顯示該筆記錄自己的欄位,
// 沒有反查關聯了哪些文件(現有 API 沒有提供這個反查端點,量體不大先不加,已知還缺)。

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { useScope } from "@/components/scope-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Drawer } from "@/components/ui/drawer";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  apiFetch,
  DOC_STATUS_LABELS,
  MANUAL_RELATION_KIND,
  OWNERSHIP_LABELS,
  STAGE_LABELS,
  WARRANTY_STATUS_LABELS,
  type DocumentRow,
  type EntityRow,
  type ExtractedField,
  type DocumentFile,
  type ProjectRow,
  type PurchaseRow,
  type AssetRow,
  type AssetDocumentLink,
  type OwnershipScope,
  type WarrantyItem,
  type WarrantyStatus,
  type ProcessingJob,
  type ActivityLogEntry,
} from "@/lib/api";
import { uploadDocument } from "@/lib/upload";

type ViewKind = "document" | "purchase" | "asset";
const VIEWS: { key: ViewKind; label: string }[] = [
  { key: "document", label: "依文件" },
  { key: "purchase", label: "依購買案" },
  { key: "asset", label: "依資產" },
];

function statusVariant(status: string): "default" | "warning" | "destructive" | "success" | "outline" {
  if (status === "failed" || status === "rejected" || status === "scrap") return "destructive";
  if (status === "review" || status === "retry" || status === "moving" || status === "pending") return "warning";
  if (status === "archived" || status === "approved" || status === "active") return "success";
  return "outline";
}

function warrantyStatusVariant(status: WarrantyStatus): "success" | "warning" | "destructive" {
  if (status === "expired") return "destructive";
  if (status === "due_soon") return "warning";
  return "success";
}

// 信心分數分級(規格 2.9):≥90 綠、60–89 黃、<60 紅。「進階／稽核」區的 OCR 信心分數/處理
// 歷程共用這組配色,跟畫面上其他信心分數顯示(例如待覆核工作台)保持一致。
function confidenceVariant(conf: number | null): "success" | "warning" | "destructive" | "outline" {
  if (conf == null) return "outline";
  if (conf >= 90) return "success";
  if (conf >= 60) return "warning";
  return "destructive";
}

function jobStatusVariant(status: string): "default" | "warning" | "destructive" | "success" | "outline" {
  if (status === "failed") return "destructive";
  if (status === "retry" || status === "running" || status === "waiting_review") return "warning";
  if (status === "completed") return "success";
  return "outline";
}

function DocumentsRoot() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const view = (searchParams.get("view") as ViewKind | null) ?? "document";
  const selectedId = searchParams.get("id");

  return (
    <AppShell>
      <h1 className="mb-4 text-xl font-semibold tracking-wide">文件</h1>
      <div className="mb-6 flex gap-2">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => router.push(`/documents?view=${v.key}`)}
            className={`border px-3 py-1.5 text-sm ${
              view === v.key ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-accent"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      {view === "document" && (
        <DocumentsView selectedId={selectedId} initialQuery={searchParams.get("q") ?? ""} initialStatus={searchParams.get("status") ?? ""} />
      )}
      {view === "purchase" && <PurchasesView selectedId={selectedId} />}
      {view === "asset" && <AssetsView selectedId={selectedId} />}
    </AppShell>
  );
}

// --- 依文件 ---

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
  processingJobs: ProcessingJob[];
}

function DocumentsView({
  selectedId,
  initialQuery,
  initialStatus,
}: {
  selectedId: string | null;
  initialQuery: string;
  initialStatus: string;
}) {
  const router = useRouter();
  const { scope } = useScope();
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>(initialStatus);
  const [query, setQuery] = useState(initialQuery);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 「進階／稽核」收合區(2026-09-16,v8 設計稿分層對齊)—— 預設收起,只顯示結論;稽核日誌
  // 是額外一次 API 呼叫,故意等使用者真的展開才抓,不是每次開文件就打。
  const [auditOpen, setAuditOpen] = useState(false);
  const [activity, setActivity] = useState<ActivityLogEntry[] | null>(null);

  // 依側邊欄範圍切換器篩選(2026-09-07 補完設計落差任務書任務 2)。
  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (scope) params.set("ownership", scope);
      const qs = params.toString();
      const data = await apiFetch<{ documents: DocumentRow[] }>(qs ? `/api/documents?${qs}` : "/api/documents");
      setDocuments(data.documents);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [statusFilter, scope]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (initialQuery) setQuery(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setAuditOpen(false);
    setActivity(null);
    apiFetch<DocumentDetail>(`/api/documents/${selectedId}`)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [selectedId]);

  useEffect(() => {
    if (!auditOpen || !selectedId || activity !== null) return;
    apiFetch<{ activity: ActivityLogEntry[] }>(`/api/activity?entityType=document&entityId=${selectedId}`)
      .then((data) => setActivity(data.activity))
      .catch(() => setActivity([]));
  }, [auditOpen, selectedId, activity]);

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
    <>
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

      {error && <div className="mb-4 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">{error}</div>}

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
                  <TableRow key={doc.id} className="cursor-pointer" onClick={() => router.push(`/documents?view=document&id=${doc.id}`)}>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{doc.id}</TableCell>
                    <TableCell className="max-w-[180px] truncate">{doc.vendorNameRaw ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{doc.invoiceNo ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {doc.amountCents != null ? `${doc.currency ?? "TWD"} ${(doc.amountCents / 100).toFixed(2)}` : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Badge variant={statusVariant(doc.status)}>{DOC_STATUS_LABELS[doc.status] ?? doc.status}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(doc.createdAt).toLocaleString("zh-TW")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Drawer open={!!selectedId} onClose={() => router.push("/documents?view=document")} title={detail?.document.id ?? "載入中…"}>
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

            {/* 進階／稽核 —— 2026-09-16,依 v8 設計稿分層對齊:預設只顯示上面的結論(狀態／
                擷取欄位／檔案／關聯),OCR 信心分數逐欄拆解、完整處理歷程、稽核日誌這些深度
                除錯資訊收進這個展開區,不跟結論一起攤開(對照 DESIGN_REVIEW_...v7 第 2 節 /
                DESIGN_REVIEW_...v8 額外確認項目)。 */}
            <section className="border-t border-border pt-4">
              <button
                type="button"
                onClick={() => setAuditOpen((v) => !v)}
                className="text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground"
              >
                {auditOpen ? "收起進階明細 −" : "展開進階明細 ＋"}
              </button>

              {auditOpen && (
                <div className="mt-3 space-y-5">
                  <div>
                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                      OCR 信心分數與來源
                    </h4>
                    <table className="w-full">
                      <tbody>
                        {detail.fields.map((f) => (
                          <tr key={`conf-${f.id}`} className="border-b border-border last:border-0">
                            <td className="w-1/4 py-1.5 pr-3 text-xs text-muted-foreground">{f.label}</td>
                            <td className="py-1.5">
                              <Badge variant={confidenceVariant(f.confidence)}>
                                {f.confidence != null ? `${f.confidence}%` : "—"}
                              </Badge>
                              {f.isUserConfirmed && (
                                <span className="ml-2 text-xs text-muted-foreground">人工確認</span>
                              )}
                            </td>
                            <td className="py-1.5 text-xs text-muted-foreground">
                              {f.extractionSource}
                              {f.sourceNote ? `・${f.sourceNote}` : ""}
                            </td>
                          </tr>
                        ))}
                        {detail.fields.length === 0 && (
                          <tr>
                            <td className="py-2 text-xs text-muted-foreground">沒有擷取欄位可拆解。</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div>
                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                      處理歷程
                    </h4>
                    <ul className="space-y-1.5 text-xs">
                      {detail.processingJobs.map((job) => (
                        <li key={job.id} className="flex flex-wrap items-center gap-2">
                          <Badge variant={jobStatusVariant(job.status)}>
                            {STAGE_LABELS[job.stageKey] ?? job.stageKey}
                          </Badge>
                          <span className="text-muted-foreground">
                            第 {job.attemptCount}/{job.maxAttempts} 次嘗試・{new Date(job.createdAt).toLocaleString("zh-TW")}
                          </span>
                          {job.errorMessage && <span className="text-destructive">{job.errorMessage}</span>}
                        </li>
                      ))}
                      {detail.processingJobs.length === 0 && (
                        <li className="text-muted-foreground">沒有處理紀錄。</li>
                      )}
                    </ul>
                  </div>

                  <div>
                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                      稽核日誌
                    </h4>
                    {activity === null && <div className="text-xs text-muted-foreground">載入中…</div>}
                    {activity !== null && activity.length === 0 && (
                      <div className="text-xs text-muted-foreground">沒有稽核紀錄。</div>
                    )}
                    {activity !== null && activity.length > 0 && (
                      <ul className="space-y-1.5 text-xs">
                        {activity.map((a) => (
                          <li key={a.id} className="flex flex-wrap items-center gap-2">
                            <span className="text-muted-foreground">{new Date(a.createdAt).toLocaleString("zh-TW")}</span>
                            <span>{a.text}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </Drawer>
    </>
  );
}

// --- 依購買案 ---

// 編輯用的欄位子集(2026-09-08 補完 CODE_TASK_fix-panel-and-editable_20260908.md 任務 3)
// —— 比照採購案現有資料模型裡「詳情畫面本來就有顯示」的那組欄位,不是把 subNote/
// accountType/payerKind/payer/categoryId/orderNo/invoiceNo 這些目前 UI 完全沒顯示過的
// 欄位也一次全塞進編輯表單——後端 API 其實都支援改,只是這次編輯 UI 先對齊既有詳情畫面
// 顯示的範圍,沒有顯示過的欄位之後有需要再擴充,已知範圍取捨記錄在報告裡。
type PurchaseEditForm = {
  ownership: OwnershipScope;
  vendorNameRaw: string;
  summary: string;
  amountCents: string;
  currency: string;
  purchaseDate: string;
  status: string;
  entityId: string;
  projectId: string;
};

function purchaseToForm(p: PurchaseRow): PurchaseEditForm {
  return {
    ownership: p.ownership as OwnershipScope,
    vendorNameRaw: p.vendorNameRaw,
    summary: p.summary,
    amountCents: String(p.amountCents / 100),
    currency: p.currency,
    purchaseDate: p.purchaseDate,
    status: p.status,
    entityId: p.entityId ?? "",
    projectId: p.projectId ?? "",
  };
}

function PurchasesView({ selectedId }: { selectedId: string | null }) {
  const router = useRouter();
  const { scope } = useScope();
  const [purchases, setPurchases] = useState<PurchaseRow[] | null>(null);
  const [detail, setDetail] = useState<{ purchase: PurchaseRow; tags: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<PurchaseEditForm | null>(null);
  const [saving, setSaving] = useState(false);
  // entity/project 篩選(2026-09-13 財務文件自動分類新增,架構文件第 6 節「List 畫面擴充
  // 篩選」)—— 後端 GET /api/purchases 已支援 entityId/projectId query param。
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [entityFilter, setEntityFilter] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ entities: EntityRow[] }>("/api/entities")
      .then((d) => setEntities(d.entities))
      .catch(() => {});
    apiFetch<{ projects: ProjectRow[] }>("/api/projects")
      .then((d) => setProjects(d.projects))
      .catch(() => {});
  }, []);

  function load() {
    const params = new URLSearchParams();
    if (scope) params.set("ownership", scope);
    if (entityFilter) params.set("entityId", entityFilter);
    if (projectFilter) params.set("projectId", projectFilter);
    const qs = params.toString();
    apiFetch<{ purchases: PurchaseRow[] }>(`/api/purchases${qs ? `?${qs}` : ""}`)
      .then((d) => setPurchases(d.purchases))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(load, [scope, entityFilter, projectFilter]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setEditing(false);
      return;
    }
    apiFetch<{ purchase: PurchaseRow; tags: string[] }>(`/api/purchases/${selectedId}`)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [selectedId]);

  async function saveEdit() {
    if (!detail || !form) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/purchases/${detail.purchase.id}`, {
        method: "POST",
        body: JSON.stringify({
          ownership: form.ownership,
          vendorNameRaw: form.vendorNameRaw,
          summary: form.summary,
          amountCents: Math.round(Number(form.amountCents) * 100),
          currency: form.currency,
          purchaseDate: form.purchaseDate,
          status: form.status,
          entityId: form.entityId || null,
          projectId: form.projectId || null,
        }),
      });
      const refreshed = await apiFetch<{ purchase: PurchaseRow; tags: string[] }>(`/api/purchases/${detail.purchase.id}`);
      setDetail(refreshed);
      setEditing(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {error && <div className="mb-4 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">{error}</div>}

      {(entities.length > 0 || projects.length > 0) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {entities.length > 0 && (
            <select
              value={entityFilter ?? ""}
              onChange={(e) => setEntityFilter(e.target.value || null)}
              className="h-[30px] border border-line bg-surface px-2 text-xs text-foreground"
            >
              <option value="">全部法律主體</option>
              {entities.map((en) => (
                <option key={en.id} value={en.id}>
                  {en.name}
                </option>
              ))}
            </select>
          )}
          {projects.length > 0 && (
            <select
              value={projectFilter ?? ""}
              onChange={(e) => setProjectFilter(e.target.value || null)}
              className="h-[30px] border border-line bg-surface px-2 text-xs text-foreground"
            >
              <option value="">全部專案</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {purchases === null && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
          {purchases?.length === 0 && <div className="p-4 text-sm text-muted-foreground">還沒有任何採購案。</div>}
          {purchases && purchases.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>採購案</TableHead>
                  <TableHead>供應商</TableHead>
                  <TableHead>摘要</TableHead>
                  <TableHead>金額</TableHead>
                  <TableHead>法律主體</TableHead>
                  <TableHead>專案</TableHead>
                  <TableHead>狀態</TableHead>
                  <TableHead>日期</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {purchases.map((p) => (
                  <TableRow key={p.id} className="cursor-pointer" onClick={() => router.push(`/documents?view=purchase&id=${p.id}`)}>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{p.id}</TableCell>
                    <TableCell className="max-w-[160px] truncate">{p.vendorNameRaw}</TableCell>
                    <TableCell className="max-w-[220px] truncate">{p.summary}</TableCell>
                    <TableCell className="whitespace-nowrap">{p.currency} {(p.amountCents / 100).toFixed(2)}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{entities.find((en) => en.id === p.entityId)?.name ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{projects.find((pr) => pr.id === p.projectId)?.name ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Badge variant={statusVariant(p.status)}>{p.status}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{p.purchaseDate}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Drawer open={!!selectedId} onClose={() => router.push("/documents?view=purchase")} title={detail?.purchase.id ?? "載入中…"}>
        {detail && !editing && (
          <div className="space-y-4 text-sm">
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setForm(purchaseToForm(detail.purchase));
                  setEditing(true);
                }}
              >
                編輯
              </Button>
            </div>
            <table className="w-full">
              <tbody>
                <tr className="border-b border-border">
                  <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">範圍</td>
                  <td className="py-1.5">{OWNERSHIP_LABELS[detail.purchase.ownership as OwnershipScope] ?? detail.purchase.ownership}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">供應商</td>
                  <td className="py-1.5">{detail.purchase.vendorNameRaw}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">摘要</td>
                  <td className="py-1.5">{detail.purchase.summary}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">金額</td>
                  <td className="py-1.5">{detail.purchase.currency} {(detail.purchase.amountCents / 100).toFixed(2)}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">日期</td>
                  <td className="py-1.5">{detail.purchase.purchaseDate}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">法律主體</td>
                  <td className="py-1.5">{entities.find((en) => en.id === detail.purchase.entityId)?.name ?? "—"}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">專案</td>
                  <td className="py-1.5">{projects.find((p) => p.id === detail.purchase.projectId)?.name ?? "—"}</td>
                </tr>
                <tr>
                  <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">狀態</td>
                  <td className="py-1.5">
                    <Badge variant={statusVariant(detail.purchase.status)}>{detail.purchase.status}</Badge>
                  </td>
                </tr>
              </tbody>
            </table>
            {detail.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {detail.tags.map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
              </div>
            )}
          </div>
        )}
        {detail && editing && form && (
          <div className="space-y-3">
            <Field label="範圍">
              <select
                value={form.ownership}
                onChange={(e) => setForm((f) => f && { ...f, ownership: e.target.value as OwnershipScope })}
                className="h-9 w-full border border-input bg-background px-2 text-sm"
              >
                {(Object.keys(OWNERSHIP_LABELS) as OwnershipScope[]).map((k) => (
                  <option key={k} value={k}>
                    {OWNERSHIP_LABELS[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="供應商">
              <Input value={form.vendorNameRaw} onChange={(e) => setForm((f) => f && { ...f, vendorNameRaw: e.target.value })} />
            </Field>
            <Field label="摘要">
              <Input value={form.summary} onChange={(e) => setForm((f) => f && { ...f, summary: e.target.value })} />
            </Field>
            <div className="flex gap-2">
              <Field label="金額">
                <Input type="number" value={form.amountCents} onChange={(e) => setForm((f) => f && { ...f, amountCents: e.target.value })} />
              </Field>
              <Field label="幣別">
                <Input value={form.currency} onChange={(e) => setForm((f) => f && { ...f, currency: e.target.value })} className="w-20" />
              </Field>
            </div>
            <Field label="日期">
              <Input type="date" value={form.purchaseDate} onChange={(e) => setForm((f) => f && { ...f, purchaseDate: e.target.value })} />
            </Field>
            <Field label="法律主體">
              <select
                value={form.entityId}
                onChange={(e) => setForm((f) => f && { ...f, entityId: e.target.value })}
                className="h-9 w-full border border-input bg-background px-2 text-sm"
              >
                <option value="">(無)</option>
                {entities.map((en) => (
                  <option key={en.id} value={en.id}>
                    {en.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="專案">
              <select
                value={form.projectId}
                onChange={(e) => setForm((f) => f && { ...f, projectId: e.target.value })}
                className="h-9 w-full border border-input bg-background px-2 text-sm"
              >
                <option value="">(無)</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="狀態">
              <select
                value={form.status}
                onChange={(e) => setForm((f) => f && { ...f, status: e.target.value })}
                className="h-9 w-full border border-input bg-background px-2 text-sm"
              >
                {["draft", "review", "archived", "failed", "retry", "dup"].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={saving}>
                取消
              </Button>
              <Button size="sm" onClick={saveEdit} disabled={saving}>
                儲存
              </Button>
            </div>
          </div>
        )}
      </Drawer>
    </>
  );
}

// --- 依資產 ---

// 欄位順序、名稱比照 2026-09-10 資產欄位對齊任務書任務 1 建議順序:
// 名稱、範圍、供應商、品牌、型號、序號、購買日期、金額、備註——清單/檢視/編輯三處统一。
// 「購買日期」對應的是 schema 既有的 acquiredDate 欄位(確認過 assets 表沒有另一個
// purchaseDate 欄位,是同一個欄位的顯示文字統一,不是新欄位)。
const EMPTY_ASSET_FORM = {
  name: "",
  ownership: "corp" as OwnershipScope,
  categoryId: "",
  vendorName: "",
  brand: "",
  model: "",
  acquiredDate: "",
  amount: "",
  serialNo: "",
  note: "",
  linkDocumentId: "",
};

// 手動新增資產(2026-09-08 補完設計落差任務書任務 2)—— 非電子發票/紙本單據沒辦法透過
// 現有 OCR/辨識流程變成資產記錄,這裡開一個不依賴 documents 的建立路徑,跟文件流程產生的
// 資產共用同一張列表(後端 GET /api/assets 不分來源,一起回傳),差別只在有沒有連結文件。
function AssetsView({ selectedId }: { selectedId: string | null }) {
  const router = useRouter();
  const { scope } = useScope();
  const [assets, setAssets] = useState<AssetRow[] | null>(null);
  const [detail, setDetail] = useState<{ asset: AssetRow; documentLinks: AssetDocumentLink[]; warranty: WarrantyItem | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_ASSET_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [editingAsset, setEditingAsset] = useState(false);
  const [editForm, setEditForm] = useState(EMPTY_ASSET_FORM);
  const [savingEdit, setSavingEdit] = useState(false);
  // 說明書(2026-09-10 資產欄位對齊任務書任務 3)—— 連結既有文件用的輸入框狀態,跟上傳新檔案
  // 共用同一個「連結」步驟(linkManualDocument),差別只在文件 ID 是使用者輸入還是上傳後拿到的。
  const [manualDocId, setManualDocId] = useState("");
  const [linkingManual, setLinkingManual] = useState(false);
  const [uploadingManual, setUploadingManual] = useState(false);
  const [manualUploadProgress, setManualUploadProgress] = useState<number | null>(null);

  function load() {
    const path = scope ? `/api/assets?ownership=${scope}` : "/api/assets";
    apiFetch<{ assets: AssetRow[] }>(path)
      .then((d) => setAssets(d.assets))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(load, [scope]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    apiFetch<{ asset: AssetRow; documentLinks: AssetDocumentLink[]; warranty: WarrantyItem | null }>(`/api/assets/${selectedId}`)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    setEditingAsset(false);
  }, [selectedId]);

  function loadAssetDetail(id: string) {
    apiFetch<{ asset: AssetRow; documentLinks: AssetDocumentLink[]; warranty: WarrantyItem | null }>(`/api/assets/${id}`)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  async function linkManualDocument(documentId: string) {
    if (!detail || !documentId.trim()) return;
    await apiFetch(`/api/assets/${detail.asset.id}/link-document`, {
      method: "POST",
      body: JSON.stringify({ documentId: documentId.trim(), relationKind: MANUAL_RELATION_KIND }),
    });
    loadAssetDetail(detail.asset.id);
  }

  async function linkExistingManual() {
    if (!manualDocId.trim()) return;
    setLinkingManual(true);
    setError(null);
    try {
      await linkManualDocument(manualDocId);
      setManualDocId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLinkingManual(false);
    }
  }

  async function uploadManual(file: File) {
    if (!detail) return;
    setUploadingManual(true);
    setManualUploadProgress(0);
    setError(null);
    try {
      const uploaded = await uploadDocument(file, detail.asset.ownership, {
        source: "web_upload",
        onProgress: setManualUploadProgress,
      });
      await linkManualDocument(uploaded.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadingManual(false);
      setManualUploadProgress(null);
    }
  }

  async function saveAssetEdit() {
    if (!detail) return;
    setSavingEdit(true);
    setError(null);
    try {
      await apiFetch(`/api/assets/${detail.asset.id}`, {
        method: "POST",
        body: JSON.stringify({
          name: editForm.name.trim(),
          ownership: editForm.ownership,
          categoryId: editForm.categoryId || undefined,
          vendorName: editForm.vendorName.trim() || null,
          brand: editForm.brand.trim() || null,
          model: editForm.model.trim() || null,
          acquiredDate: editForm.acquiredDate || null,
          amountCents: editForm.amount ? Math.round(Number(editForm.amount) * 100) : null,
          serialNo: editForm.serialNo.trim() || null,
          note: editForm.note.trim() || null,
        }),
      });
      loadAssetDetail(detail.asset.id);
      setEditingAsset(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEdit(false);
    }
  }

  async function addAsset() {
    if (!form.name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/api/assets", {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          ownership: form.ownership,
          categoryId: form.categoryId || undefined,
          vendorName: form.vendorName.trim() || undefined,
          brand: form.brand.trim() || undefined,
          model: form.model.trim() || undefined,
          acquiredDate: form.acquiredDate || undefined,
          amountCents: form.amount ? Math.round(Number(form.amount) * 100) : undefined,
          serialNo: form.serialNo.trim() || undefined,
          note: form.note.trim() || undefined,
          linkDocumentId: form.linkDocumentId.trim() || undefined,
        }),
      });
      setForm(EMPTY_ASSET_FORM);
      setShowForm(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button size="sm" onClick={() => setShowForm((v) => !v)}>
          + 新增資產
        </Button>
      </div>

      {error && <div className="mb-4 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">{error}</div>}

      {showForm && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>手動新增資產</CardTitle>
            <p className="text-xs text-foreground-3">給非電子發票、紙本單據等沒辦法透過辨識流程建立的資產用——關聯文件是選填,之後補電子憑證也可以。</p>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="品名">
                <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="w-48" />
              </Field>
              <Field label="範圍">
                <select
                  value={form.ownership}
                  onChange={(e) => setForm((f) => ({ ...f, ownership: e.target.value as OwnershipScope }))}
                  className="h-9 border border-input bg-background px-2 text-sm"
                >
                  {(Object.keys(OWNERSHIP_LABELS) as OwnershipScope[]).map((k) => (
                    <option key={k} value={k}>
                      {OWNERSHIP_LABELS[k]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="供應商(選填)">
                <Input value={form.vendorName} onChange={(e) => setForm((f) => ({ ...f, vendorName: e.target.value }))} className="w-36" />
              </Field>
              <Field label="品牌(選填)">
                <Input value={form.brand} onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))} className="w-28" />
              </Field>
              <Field label="型號(選填)">
                <Input value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} className="w-28" />
              </Field>
              <Field label="購買日期(選填)">
                <Input type="date" value={form.acquiredDate} onChange={(e) => setForm((f) => ({ ...f, acquiredDate: e.target.value }))} className="w-40" />
              </Field>
              <Field label="金額(選填)">
                <Input type="number" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} className="w-28" />
              </Field>
              <Field label="序號(選填)">
                <Input value={form.serialNo} onChange={(e) => setForm((f) => ({ ...f, serialNo: e.target.value }))} className="w-32" />
              </Field>
              <Field label="關聯文件 ID(選填)">
                <Input
                  value={form.linkDocumentId}
                  onChange={(e) => setForm((f) => ({ ...f, linkDocumentId: e.target.value }))}
                  placeholder="DOC-2026-000001"
                  className="w-40"
                />
              </Field>
              <Field label="備註(選填)">
                <Input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} className="w-48" />
              </Field>
              <Button size="sm" disabled={submitting || !form.name.trim()} onClick={addAsset}>
                儲存
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {assets === null && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
          {assets?.length === 0 && <div className="p-4 text-sm text-muted-foreground">還沒有任何資產。</div>}
          {assets && assets.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>資產</TableHead>
                  <TableHead>名稱</TableHead>
                  <TableHead>範圍</TableHead>
                  <TableHead>供應商</TableHead>
                  <TableHead>品牌</TableHead>
                  <TableHead>型號</TableHead>
                  <TableHead>序號</TableHead>
                  <TableHead>購買日期</TableHead>
                  <TableHead>金額</TableHead>
                  <TableHead>備註</TableHead>
                  <TableHead>狀態</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assets.map((a) => (
                  <TableRow key={a.id} className="cursor-pointer" onClick={() => router.push(`/documents?view=asset&id=${a.id}`)}>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{a.id}</TableCell>
                    <TableCell className="max-w-[160px] truncate">{a.name}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{OWNERSHIP_LABELS[a.ownership as OwnershipScope] ?? a.ownership}</TableCell>
                    <TableCell className="max-w-[140px] truncate text-xs text-muted-foreground">{a.vendorName ?? "—"}</TableCell>
                    <TableCell className="max-w-[120px] truncate">{a.brand ?? "—"}</TableCell>
                    <TableCell className="max-w-[120px] truncate">{a.model ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{a.serialNo ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{a.acquiredDate ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {a.amountCents != null ? `${a.currency ?? "TWD"} ${(a.amountCents / 100).toLocaleString()}` : "—"}
                    </TableCell>
                    <TableCell className="max-w-[10rem] truncate text-xs text-muted-foreground">{a.note ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Badge variant={statusVariant(a.status)}>{a.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Drawer open={!!selectedId} onClose={() => router.push("/documents?view=asset")} title={detail?.asset.id ?? "載入中…"}>
        {detail && !editingAsset && (
          <>
            <div className="mb-3 flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditForm({
                    name: detail.asset.name,
                    ownership: detail.asset.ownership as OwnershipScope,
                    categoryId: detail.asset.categoryId ?? "",
                    vendorName: detail.asset.vendorName ?? "",
                    brand: detail.asset.brand ?? "",
                    model: detail.asset.model ?? "",
                    acquiredDate: detail.asset.acquiredDate ?? "",
                    amount: detail.asset.amountCents != null ? String(detail.asset.amountCents / 100) : "",
                    serialNo: detail.asset.serialNo ?? "",
                    note: detail.asset.note ?? "",
                    linkDocumentId: "",
                  });
                  setEditingAsset(true);
                }}
              >
                編輯
              </Button>
            </div>
            <table className="w-full text-sm">
              <tbody>
                <tr className="border-b border-border">
                  <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">名稱</td>
                  <td className="py-1.5">{detail.asset.name}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">範圍</td>
                  <td className="py-1.5">{OWNERSHIP_LABELS[detail.asset.ownership as OwnershipScope] ?? detail.asset.ownership}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">供應商</td>
                  <td className="py-1.5">{detail.asset.vendorName ?? "—"}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">品牌</td>
                  <td className="py-1.5">{detail.asset.brand ?? "—"}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">型號</td>
                  <td className="py-1.5">{detail.asset.model ?? "—"}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">序號</td>
                  <td className="py-1.5">{detail.asset.serialNo ?? "—"}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">購買日期</td>
                  <td className="py-1.5">{detail.asset.acquiredDate ?? "—"}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">金額</td>
                  <td className="py-1.5">{detail.asset.amountCents != null ? `${detail.asset.currency ?? "TWD"} ${(detail.asset.amountCents / 100).toLocaleString()}` : "—"}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">備註</td>
                  <td className="py-1.5">{detail.asset.note ?? "—"}</td>
                </tr>
                <tr className="border-b border-border">
                  <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">狀態</td>
                  <td className="py-1.5">
                    <Badge variant={statusVariant(detail.asset.status)}>{detail.asset.status}</Badge>
                  </td>
                </tr>
                <tr>
                  <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">保固狀態</td>
                  <td className="py-1.5">
                    {detail.warranty ? (
                      <div className="flex items-center gap-2">
                        <Badge variant={warrantyStatusVariant(detail.warranty.status)}>{WARRANTY_STATUS_LABELS[detail.warranty.status]}</Badge>
                        <button
                          type="button"
                          className="text-xs text-primary hover:underline"
                          onClick={() => router.push(`/warranty?entityId=${detail.asset.id}`)}
                        >
                          查看
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="text-xs text-primary hover:underline"
                        onClick={() =>
                          router.push(`/warranty?newEntityType=asset&newEntityId=${detail.asset.id}&newOwnership=${detail.asset.ownership}`)
                        }
                      >
                        + 新增保固
                      </button>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>

            {/* 關聯文件依角色分兩個子清單(2026-09-10 資產欄位對齊任務書任務 3)—— 沿用既有的
                document_asset_links.relationKind 欄位,relationKind='manual' 是說明書,其餘
                (primary/supporting/warranty,含所有舊資料)歸類為憑證,不用回溯改舊資料。 */}
            <div className="mt-4">
              <div className="mb-2 text-xs font-medium text-foreground-2">憑證</div>
              {detail.documentLinks.filter((l) => l.relationKind !== MANUAL_RELATION_KIND).length === 0 && (
                <p className="text-xs text-muted-foreground">還沒有連結任何憑證文件。</p>
              )}
              {detail.documentLinks
                .filter((l) => l.relationKind !== MANUAL_RELATION_KIND)
                .map((link) => (
                  <div key={link.documentId} className="border-b border-line-2 py-1.5 text-xs last:border-0">
                    <span className="font-mono">{link.documentId}</span> · {link.vendorNameRaw ?? "—"} · {link.status}
                  </div>
                ))}
            </div>

            <div className="mt-4">
              <div className="mb-2 text-xs font-medium text-foreground-2">說明書</div>
              {detail.documentLinks.filter((l) => l.relationKind === MANUAL_RELATION_KIND).length === 0 && (
                <p className="text-xs text-muted-foreground">還沒有連結任何說明書(選填)。</p>
              )}
              {detail.documentLinks
                .filter((l) => l.relationKind === MANUAL_RELATION_KIND)
                .map((link) => (
                  <div key={link.documentId} className="border-b border-line-2 py-1.5 text-xs last:border-0">
                    <span className="font-mono">{link.documentId}</span> · {link.vendorNameRaw ?? "—"} · {link.status}
                  </div>
                ))}

              <div className="mt-3 space-y-2 border-t border-line-2 pt-3">
                <div className="flex items-center gap-2">
                  <Input
                    value={manualDocId}
                    onChange={(e) => setManualDocId(e.target.value)}
                    placeholder="連結既有文件 ID,例如 DOC-2026-000001"
                    className="h-8 flex-1 text-xs"
                  />
                  <Button size="sm" variant="outline" disabled={linkingManual || !manualDocId.trim()} onClick={linkExistingManual}>
                    連結
                  </Button>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <label className="cursor-pointer text-primary hover:underline">
                    上傳新的說明書檔案
                    <input
                      type="file"
                      accept="application/pdf,image/*"
                      className="hidden"
                      disabled={uploadingManual}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (file) uploadManual(file);
                      }}
                    />
                  </label>
                  {uploadingManual && <span>上傳中{manualUploadProgress != null ? `(${manualUploadProgress}%)` : ""}…</span>}
                </div>
              </div>
            </div>
          </>
        )}
        {detail && editingAsset && (
          <div className="space-y-3">
            <Field label="品名">
              <Input value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
            </Field>
            <Field label="範圍">
              <select
                value={editForm.ownership}
                onChange={(e) => setEditForm((f) => ({ ...f, ownership: e.target.value as OwnershipScope }))}
                className="h-9 w-full border border-input bg-background px-2 text-sm"
              >
                {(Object.keys(OWNERSHIP_LABELS) as OwnershipScope[]).map((k) => (
                  <option key={k} value={k}>
                    {OWNERSHIP_LABELS[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="供應商">
              <Input value={editForm.vendorName} onChange={(e) => setEditForm((f) => ({ ...f, vendorName: e.target.value }))} />
            </Field>
            <div className="flex gap-2">
              <Field label="品牌">
                <Input value={editForm.brand} onChange={(e) => setEditForm((f) => ({ ...f, brand: e.target.value }))} />
              </Field>
              <Field label="型號">
                <Input value={editForm.model} onChange={(e) => setEditForm((f) => ({ ...f, model: e.target.value }))} />
              </Field>
            </div>
            <Field label="序號">
              <Input value={editForm.serialNo} onChange={(e) => setEditForm((f) => ({ ...f, serialNo: e.target.value }))} />
            </Field>
            <div className="flex gap-2">
              <Field label="購買日期">
                <Input type="date" value={editForm.acquiredDate} onChange={(e) => setEditForm((f) => ({ ...f, acquiredDate: e.target.value }))} />
              </Field>
              <Field label="金額">
                <Input type="number" value={editForm.amount} onChange={(e) => setEditForm((f) => ({ ...f, amount: e.target.value }))} />
              </Field>
            </div>
            <Field label="備註">
              <Input value={editForm.note} onChange={(e) => setEditForm((f) => ({ ...f, note: e.target.value }))} />
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button size="sm" variant="outline" onClick={() => setEditingAsset(false)} disabled={savingEdit}>
                取消
              </Button>
              <Button size="sm" disabled={savingEdit || !editForm.name.trim()} onClick={saveAssetEdit}>
                儲存
              </Button>
            </div>
          </div>
        )}
      </Drawer>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

export default function DocumentsPage() {
  return (
    <Suspense fallback={null}>
      <DocumentsRoot />
    </Suspense>
  );
}
