"use client";

// 依標題瀏覽(2026-09-16)—— 取代購買案/資產/文件庫的新主要瀏覽入口,見
// paraacco-browse-by-title-design-evaluation-20260916.md、
// CODE_TASK_browse-by-title-open-questions-decision_20260916.md。
//
// 兩層結構:分類清單 → 該分類底下的供應商清單 → 點供應商看底下的文件/採購案 + 同一案件的
// 關聯文件群組(document_case_links)。用查詢字串驅動(?category=&vendor=),跟既有
// app/documents/page.tsx 的 view 切換是同一種慣例,不是新的路由模式。
//
// 已知限制:資產(assets)目前只有 vendorName 自由文字,沒有 vendorId 外鍵(見設計文件第 1
// 節),這裡的供應商詳情頁暫時不顯示資產,只顯示文件跟採購案——之後如果要把資產也納入,
// 需要先決定資產要不要補 vendorId 外鍵,這次不擅自加。
//
// 側邊欄導覽入口(拿掉購買案/資產/文件庫)按計畫排在這個頁面做完、Theo 實際用過確認可用
// 之後才切換,這次先不動 app-shell.tsx 的 NAV。

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { useScope } from "@/components/scope-context";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  apiFetch,
  CASE_LINK_ROLE_LABELS,
  DOC_STATUS_LABELS,
  type CaseGroup,
  type CategoryRow,
  type DocumentRow,
  type PurchaseRow,
  type VendorRow,
} from "@/lib/api";

function BrowseRoot() {
  const searchParams = useSearchParams();
  const categoryId = searchParams.get("category");
  const vendorId = searchParams.get("vendor");

  if (vendorId && categoryId) return <VendorDetail categoryId={categoryId} vendorId={vendorId} />;
  if (categoryId) return <VendorList categoryId={categoryId} />;
  return <CategoryList />;
}

function Breadcrumb({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <div className="mb-3 flex items-center gap-1.5 text-xs text-foreground-3">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <ChevronRight size={11} />}
          {item.href ? (
            <Link href={item.href} className="text-foreground-2 hover:text-brand hover:underline">
              {item.label}
            </Link>
          ) : (
            <span className="text-foreground">{item.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}

function CategoryList() {
  const [categories, setCategories] = useState<CategoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ categories: CategoryRow[] }>("/api/categories")
      .then((d) => setCategories(d.categories))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <AppShell>
      <div className="mb-1.5 flex items-baseline gap-2.5">
        <h1 className="m-0 text-[23px] font-extrabold tracking-tight">依標題瀏覽</h1>
        <span className="font-mono text-[10px] tracking-[0.16em] text-foreground-3">BROWSE</span>
      </div>
      <p className="mb-5 text-sm text-foreground-2">照分類(像 NAS 資料夾一樣)找對應的供應商,再看底下的文件/採購案。</p>

      {error && <div className="mb-4 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">{error}</div>}
      {categories === null && <div className="text-sm text-muted-foreground">載入中…</div>}
      {categories?.length === 0 && <div className="text-sm text-muted-foreground">還沒有任何分類。</div>}

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
        {categories?.map((cat) => (
          <Link
            key={cat.id}
            href={`/browse?category=${cat.id}`}
            className="flex flex-col gap-1 border border-line bg-card p-4 no-underline hover:border-border"
          >
            <span className="text-[15px] font-semibold text-foreground">{cat.name}</span>
            <span className="font-mono text-[10px] text-foreground-3">{cat.id}</span>
          </Link>
        ))}
      </div>
    </AppShell>
  );
}

function VendorList({ categoryId }: { categoryId: string }) {
  const [category, setCategory] = useState<CategoryRow | null>(null);
  const [vendors, setVendors] = useState<VendorRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ categories: CategoryRow[] }>("/api/categories")
      .then((d) => setCategory(d.categories.find((c) => c.id === categoryId) ?? null))
      .catch(() => {});
    apiFetch<{ vendors: VendorRow[] }>(`/api/vendors?categoryId=${categoryId}`)
      .then((d) => setVendors(d.vendors))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [categoryId]);

  return (
    <AppShell>
      <Breadcrumb items={[{ label: "依標題瀏覽", href: "/browse" }, { label: category?.name ?? categoryId }]} />
      <div className="mb-5 flex items-baseline gap-2.5">
        <h1 className="m-0 text-[23px] font-extrabold tracking-tight">{category?.name ?? "…"}</h1>
      </div>

      {error && <div className="mb-4 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">{error}</div>}
      {vendors === null && <div className="text-sm text-muted-foreground">載入中…</div>}
      {vendors?.length === 0 && <div className="text-sm text-muted-foreground">這個分類底下還沒有任何供應商。</div>}

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        {vendors?.map((v) => (
          <Link
            key={v.id}
            href={`/browse?category=${categoryId}&vendor=${v.id}`}
            className="flex flex-col gap-1 border border-line bg-card p-4 no-underline hover:border-border"
          >
            <span className="text-[15px] font-semibold text-foreground">{v.name}</span>
            {v.taxId && <span className="font-mono text-[10px] text-foreground-3">統編 {v.taxId}</span>}
          </Link>
        ))}
      </div>
    </AppShell>
  );
}

function VendorDetail({ categoryId, vendorId }: { categoryId: string; vendorId: string }) {
  const router = useRouter();
  const { scope } = useScope();
  const [category, setCategory] = useState<CategoryRow | null>(null);
  const [vendor, setVendor] = useState<VendorRow | null>(null);
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [purchases, setPurchases] = useState<PurchaseRow[] | null>(null);
  const [caseGroups, setCaseGroups] = useState<Map<string, CaseGroup>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ categories: CategoryRow[] }>("/api/categories")
      .then((d) => setCategory(d.categories.find((c) => c.id === categoryId) ?? null))
      .catch(() => {});
    apiFetch<{ vendor: VendorRow }>(`/api/vendors/${vendorId}`)
      .then((d) => setVendor(d.vendor))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [categoryId, vendorId]);

  useEffect(() => {
    const q = scope ? `&ownership=${scope}` : "";
    setDocuments(null);
    setPurchases(null);
    apiFetch<{ documents: DocumentRow[] }>(`/api/documents?vendorId=${vendorId}${q}`)
      .then((d) => {
        setDocuments(d.documents);
        // 每份文件查一次有沒有案件關聯——文件數通常不多(單一供應商底下),先求能動,
        // 量大了再考慮換成一次撈全部的聚合端點。
        d.documents.forEach((doc) => {
          apiFetch<{ cases: CaseGroup[] }>(`/api/case-links/documents/${doc.id}`)
            .then((r) => {
              if (r.cases.length === 0) return;
              setCaseGroups((prev) => {
                const next = new Map(prev);
                r.cases.forEach((g) => next.set(g.caseId, g));
                return next;
              });
            })
            .catch(() => {});
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    apiFetch<{ purchases: PurchaseRow[] }>(`/api/purchases?vendorId=${vendorId}${q}`)
      .then((d) => setPurchases(d.purchases))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [vendorId, scope]);

  const groupedCaseDocIds = new Set([...caseGroups.values()].flatMap((g) => g.documents.map((d) => d.documentId)));
  const ungroupedDocuments = documents?.filter((d) => !groupedCaseDocIds.has(d.id)) ?? [];

  return (
    <AppShell>
      <Breadcrumb
        items={[
          { label: "依標題瀏覽", href: "/browse" },
          { label: category?.name ?? categoryId, href: `/browse?category=${categoryId}` },
          { label: vendor?.name ?? vendorId },
        ]}
      />
      <div className="mb-5 flex items-baseline gap-2.5">
        <h1 className="m-0 text-[23px] font-extrabold tracking-tight">{vendor?.name ?? "…"}</h1>
        {vendor?.taxId && <span className="font-mono text-xs text-foreground-3">統編 {vendor.taxId}</span>}
      </div>

      {error && <div className="mb-4 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">{error}</div>}

      {caseGroups.size > 0 && (
        <div className="mb-5">
          <h2 className="mb-2 text-sm font-bold">關聯文件群組</h2>
          <div className="space-y-3">
            {[...caseGroups.values()].map((group) => (
              <Card key={group.caseId}>
                <CardContent className="p-0">
                  <div className="border-b border-line-2 px-3.5 py-2 font-mono text-[11px] text-foreground-3">案件 {group.caseId}</div>
                  {group.documents.map((d) => (
                    <div key={d.documentId} className="flex items-center justify-between border-b border-line-2 px-3.5 py-2 text-sm last:border-0">
                      <span className="flex items-center gap-2">
                        <Badge variant="info">{CASE_LINK_ROLE_LABELS[d.role] ?? d.role}</Badge>
                        <span className="font-mono text-xs text-foreground-3">{d.documentId}</span>
                        <span>{d.docDate ?? "—"}</span>
                      </span>
                      <Badge variant="outline">{DOC_STATUS_LABELS[d.status as keyof typeof DOC_STATUS_LABELS] ?? d.status}</Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      <div className="mb-5">
        <h2 className="mb-2 text-sm font-bold">文件</h2>
        <Card>
          <CardContent className="p-0">
            {documents === null && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
            {documents !== null && ungroupedDocuments.length === 0 && caseGroups.size === 0 && (
              <div className="p-4 text-sm text-muted-foreground">這個供應商底下還沒有任何文件。</div>
            )}
            {ungroupedDocuments.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>文件</TableHead>
                    <TableHead>類型</TableHead>
                    <TableHead>日期</TableHead>
                    <TableHead>狀態</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ungroupedDocuments.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="font-mono text-xs">{d.id}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{d.docTypeCode ?? "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{d.docDate ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{DOC_STATUS_LABELS[d.status]}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-bold">採購案</h2>
        <Card>
          <CardContent className="p-0">
            {purchases === null && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
            {purchases?.length === 0 && <div className="p-4 text-sm text-muted-foreground">這個供應商底下還沒有任何採購案。</div>}
            {purchases && purchases.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>採購案</TableHead>
                    <TableHead>摘要</TableHead>
                    <TableHead>金額</TableHead>
                    <TableHead>日期</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {purchases.map((p) => (
                    <TableRow key={p.id} className="cursor-pointer" onClick={() => router.push(`/documents?view=purchase&id=${p.id}`)}>
                      <TableCell className="font-mono text-xs">{p.id}</TableCell>
                      <TableCell>{p.summary}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {p.currency} {(p.amountCents / 100).toFixed(2)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{p.purchaseDate}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

export default function BrowsePage() {
  return (
    <Suspense fallback={null}>
      <BrowseRoot />
    </Suspense>
  );
}
