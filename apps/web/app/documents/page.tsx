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
  type PurchaseRow,
  type AssetRow,
} from "@/lib/api";

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
          </div>
        )}
      </Drawer>
    </>
  );
}

// --- 依購買案 ---

function PurchasesView({ selectedId }: { selectedId: string | null }) {
  const router = useRouter();
  const { scope } = useScope();
  const [purchases, setPurchases] = useState<PurchaseRow[] | null>(null);
  const [detail, setDetail] = useState<{ purchase: PurchaseRow; tags: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const path = scope ? `/api/purchases?ownership=${scope}` : "/api/purchases";
    apiFetch<{ purchases: PurchaseRow[] }>(path)
      .then((d) => setPurchases(d.purchases))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [scope]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    apiFetch<{ purchase: PurchaseRow; tags: string[] }>(`/api/purchases/${selectedId}`)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [selectedId]);

  return (
    <>
      {error && <div className="mb-4 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">{error}</div>}
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
                  <TableHead>狀態</TableHead>
                  <TableHead>日期</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {purchases.map((p) => (
                  <TableRow key={p.id} className="cursor-pointer" onClick={() => router.push(`/documents?view=purchase&id=${p.id}`)}>
                    <TableCell className="font-mono text-xs">{p.id}</TableCell>
                    <TableCell>{p.vendorNameRaw}</TableCell>
                    <TableCell className="truncate">{p.summary}</TableCell>
                    <TableCell>{p.currency} {(p.amountCents / 100).toFixed(2)}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(p.status)}>{p.status}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{p.purchaseDate}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Drawer open={!!selectedId} onClose={() => router.push("/documents?view=purchase")} title={detail?.purchase.id ?? "載入中…"}>
        {detail && (
          <div className="space-y-4 text-sm">
            <table className="w-full">
              <tbody>
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
      </Drawer>
    </>
  );
}

// --- 依資產 ---

function AssetsView({ selectedId }: { selectedId: string | null }) {
  const router = useRouter();
  const { scope } = useScope();
  const [assets, setAssets] = useState<AssetRow[] | null>(null);
  const [detail, setDetail] = useState<{ asset: AssetRow } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const path = scope ? `/api/assets?ownership=${scope}` : "/api/assets";
    apiFetch<{ assets: AssetRow[] }>(path)
      .then((d) => setAssets(d.assets))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [scope]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    apiFetch<{ asset: AssetRow }>(`/api/assets/${selectedId}`)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [selectedId]);

  return (
    <>
      {error && <div className="mb-4 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">{error}</div>}
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
                  <TableHead>品牌</TableHead>
                  <TableHead>型號</TableHead>
                  <TableHead>序號</TableHead>
                  <TableHead>狀態</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assets.map((a) => (
                  <TableRow key={a.id} className="cursor-pointer" onClick={() => router.push(`/documents?view=asset&id=${a.id}`)}>
                    <TableCell className="font-mono text-xs">{a.id}</TableCell>
                    <TableCell>{a.name}</TableCell>
                    <TableCell>{a.brand ?? "—"}</TableCell>
                    <TableCell>{a.model ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{a.serialNo ?? "—"}</TableCell>
                    <TableCell>
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
        {detail && (
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-border">
                <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">名稱</td>
                <td className="py-1.5">{detail.asset.name}</td>
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
              <tr>
                <td className="w-1/3 py-1.5 pr-3 text-xs text-muted-foreground">狀態</td>
                <td className="py-1.5">
                  <Badge variant={statusVariant(detail.asset.status)}>{detail.asset.status}</Badge>
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </Drawer>
    </>
  );
}

export default function DocumentsPage() {
  return (
    <Suspense fallback={null}>
      <DocumentsRoot />
    </Suspense>
  );
}
