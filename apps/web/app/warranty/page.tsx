"use client";

// 保固與訂閱(2026-09-07 補完設計落差任務書任務 3)—— 列表依到期日排序、即將到期用警示色,
// 支援新增/編輯/刪除。狀態(使用中/即將到期/已過期)是後端即時算的(見
// apps/api/src/routes/warranty.ts),這裡直接顯示,不重算。
//
// 2026-09-10 資產欄位對齊任務書任務 2:支援從資產詳情頁跳轉過來——
// ?entityId=<assetId> 篩選只看該資產掛的紀錄(對應「點保固狀態導到這裡」);
// ?newEntityType=asset&newEntityId=<assetId>&newOwnership=<scope> 預先帶入新增表單並
// 自動展開(對應「還沒有保固紀錄時顯示 + 新增保固」)。
//
// 2026-09-26(migration 0008):擴充成「保固、訂閱與定期繳費」——水電、網路、瓦斯、勞健保、稅金
// 等定期繳交費用放在同一頁(type='recurring_bill'),加細分類、金額、繳費方式、用戶號碼欄位,
// 頂部分頁篩選類型;定期繳費/訂閱列有「已繳」按鈕,把到期日推到下一期(API: POST /:id/advance)。
//
// 2026-09-29(CODE_TASK_recurring-bills-single-page_20260929_V1.01.md 2.3):改回「保固與訂閱」——定期繳費搬到
// /recurring「定期繳費」;分頁只剩 全部/訂閱/保固,類型下拉拿掉定期繳費,分類只留軟體/硬體/其他。
// 訂閱(例 Claude Pro)不算定期繳費,留在這頁。
//
// 2026-11-19:訂閱也併入 /recurring(分類「訂閱/軟體」),這頁改名「設備保固」——只列 type='warranty' 與物件品項的保固;
// 拿掉類型分頁、類型/分類/週期/繳費方式/用戶號碼欄位與「已繳」。

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { useScope } from "@/components/scope-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCents } from "@/lib/format";
import {
  apiFetch,
  OWNERSHIP_LABELS,
  WARRANTY_STATUS_LABELS,
  type OwnershipScope,
  type WarrantyItem,
  type WarrantyStatus,
} from "@/lib/api";

interface ItemWarranty {
  itemId: string;
  purchaseId: string;
  name: string;
  brand: string | null;
  model: string | null;
  serialNo: string | null;
  vendorName: string | null;
  ownership: OwnershipScope;
  startDate: string | null;
  endDate: string;
  status: WarrantyStatus;
}

function statusLabel(item: WarrantyItem): string {
  return WARRANTY_STATUS_LABELS[item.status];
}

const formatAmount = (cents: number | null) => formatCents(cents);

function statusVariant(status: WarrantyStatus): "success" | "warning" | "destructive" {
  if (status === "expired") return "destructive";
  if (status === "due_soon") return "warning";
  return "success";
}

function emptyForm(entityType: "" | "asset" = "", entityId = "", ownership: OwnershipScope = "corp") {
  return {
    name: "",
    vendorName: "",
    ownership,
    endDate: "",
    amount: "",
    reminderDaysBefore: "30",
    note: "",
    entityType,
    entityId,
  };
}

function WarrantyRoot() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { scope } = useScope();
  const [items, setItems] = useState<WarrantyItem[] | null>(null);
  // 2026-09-29:保固記在物件品項上(CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md 2.5、5.1),唯讀列出,點回物件編輯。
  const [itemWarranties, setItemWarranties] = useState<ItemWarranty[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const filterEntityId = searchParams.get("entityId");
  const newEntityId = searchParams.get("newEntityId");

  function load() {
    const path = scope ? `/api/warranty?ownership=${scope}` : "/api/warranty";
    apiFetch<{ items: WarrantyItem[]; itemWarranties?: ItemWarranty[] }>(path)
      .then((d) => {
        setItems(d.items);
        setItemWarranties(d.itemWarranties ?? []);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(load, [scope]);

  // 從資產詳情頁「+ 新增保固」過來——帶入 entityType/entityId/ownership,自動展開表單。
  useEffect(() => {
    if (!newEntityId) return;
    const newEntityType = searchParams.get("newEntityType");
    const newOwnership = searchParams.get("newOwnership");
    if (newEntityType === "asset") {
      setForm(emptyForm("asset", newEntityId, (newOwnership as OwnershipScope) ?? "corp"));
      setShowForm(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newEntityId]);

  // API 預設只回 type='warranty';這裡再擋一次(舊版 API 還沒部署時)。
  const displayItemsAll = items ? items.filter((i) => i.type === "warranty") : null;
  const displayItems = displayItemsAll ? displayItemsAll.filter((i) => !filterEntityId || i.entityId === filterEntityId) : null;

  const amountValid = form.amount.trim() === "" || /^\d+(\.\d{1,2})?$/.test(form.amount.trim());

  async function addItem() {
    if (!form.name.trim() || !form.endDate || !amountValid) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/api/warranty", {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          type: "warranty",
          category: "device",
          vendorName: form.vendorName.trim() || undefined,
          ownership: form.ownership,
          endDate: form.endDate,
          renewalCycle: "one_time",
          // 元 → 整數分(字串運算,避免 0.1+0.2 這類浮點誤差)
          amountCents: form.amount.trim() ? toCents(form.amount.trim()) : undefined,
          reminderDaysBefore: Number(form.reminderDaysBefore) || 30,
          note: form.note.trim() || undefined,
          entityType: form.entityType || undefined,
          entityId: form.entityId || undefined,
        }),
      });
      setForm(emptyForm());
      setShowForm(false);
      router.replace("/warranty");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function removeItem(id: string) {
    if (!confirm("確定要刪除這筆紀錄嗎?")) return;
    await apiFetch(`/api/warranty/${id}/delete`, { method: "POST" }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    load();
  }

  return (
    <AppShell>
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-baseline gap-2.5">
          <h1 className="m-0 text-[23px] font-extrabold tracking-tight">設備保固</h1>
          <span className="font-mono text-[10px] tracking-[0.16em] text-foreground-3">WARRANTY</span>
        </div>
        <Button size="sm" onClick={() => setShowForm((v) => !v)}>
          <Plus size={14} className="mr-1" />
          新增
        </Button>
      </div>
      <p className="mb-4 text-sm text-foreground-2">
        設備保固到期提醒——可以獨立存在,也可以掛在資產上;物件品項填了保固迄日也會列在這裡。軟體訂閱、水電、網路、勞健保、稅金等請到{" "}
        <a href="/recurring" className="text-primary hover:underline">
          定期繳費
        </a>
        。
      </p>

      {filterEntityId && (
        <div className="mb-4 flex items-center justify-between border border-line-2 bg-surface-2 p-3 text-sm">
          <span>正在檢視資產 <span className="font-mono text-xs">{filterEntityId}</span> 掛的保固紀錄</span>
          <button type="button" className="text-xs text-primary hover:underline" onClick={() => router.push("/warranty")}>
            看全部
          </button>
        </div>
      )}

      {error && <div className="mb-4 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">{error}</div>}

      {showForm && (
        <Card className="mb-5">
          <CardHeader>
            <CardTitle>新增設備保固</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="名稱">
                <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="w-48" />
              </Field>
              <Field label="供應商(選填)">
                <Input value={form.vendorName} onChange={(e) => setForm((f) => ({ ...f, vendorName: e.target.value }))} className="w-40" />
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
              <Field label="保固到期日">
                <Input type="date" value={form.endDate} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} className="w-40" />
              </Field>
              <Field label="金額(元,選填)">
                <Input
                  inputMode="decimal"
                  value={form.amount}
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                  className={`w-28 ${amountValid ? "" : "border-destructive"}`}
                />
              </Field>
              <Field label="提醒天數">
                <Input
                  type="number"
                  value={form.reminderDaysBefore}
                  onChange={(e) => setForm((f) => ({ ...f, reminderDaysBefore: e.target.value }))}
                  className="w-24"
                />
              </Field>
              <Button size="sm" disabled={submitting || !form.name.trim() || !form.endDate || !amountValid} onClick={addItem}>
                儲存
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {!filterEntityId && itemWarranties.length > 0 && (
        <Card className="mb-5">
          <CardHeader>
            <CardTitle>物件品項的保固({itemWarranties.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>品項</TableHead>
                  <TableHead>序號</TableHead>
                  <TableHead>供應商</TableHead>
                  <TableHead>範圍</TableHead>
                  <TableHead>保固起訖</TableHead>
                  <TableHead>狀態</TableHead>
                  <TableHead>物件</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {itemWarranties.map((w) => (
                  <TableRow key={w.itemId}>
                    <TableCell className="max-w-[220px] truncate">
                      {w.name}
                      {(w.brand || w.model) && <span className="ml-1 text-xs text-muted-foreground">{[w.brand, w.model].filter(Boolean).join(" ")}</span>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{w.serialNo ?? "—"}</TableCell>
                    <TableCell className="max-w-[140px] truncate text-xs text-muted-foreground">{w.vendorName ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{OWNERSHIP_LABELS[w.ownership] ?? w.ownership}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {w.startDate ?? "—"} ~ {w.endDate}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(w.status)}>{WARRANTY_STATUS_LABELS[w.status]}</Badge>
                    </TableCell>
                    <TableCell>
                      <button type="button" className="font-mono text-xs text-primary hover:underline" onClick={() => router.push(`/documents?view=purchase&id=${w.purchaseId}`)}>
                        {w.purchaseId}
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {displayItems === null && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
          {displayItems?.length === 0 && <div className="p-4 text-sm text-muted-foreground">還沒有獨立的設備保固紀錄。</div>}
          {displayItems && displayItems.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名稱</TableHead>
                  <TableHead>供應商</TableHead>
                  <TableHead>範圍</TableHead>
                  <TableHead className="text-right">金額</TableHead>
                  <TableHead>保固到期</TableHead>
                  <TableHead>狀態</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayItems.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="max-w-[200px] truncate">{item.name}</TableCell>
                    <TableCell className="max-w-[140px] truncate text-xs text-muted-foreground" title={item.accountRef ?? undefined}>
                      {item.vendorName ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{OWNERSHIP_LABELS[item.ownership]}</TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono text-xs">{formatAmount(item.amountCents)}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{item.endDate}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(item.status)}>{statusLabel(item)}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <button type="button" onClick={() => removeItem(item.id)} className="text-foreground-3 hover:text-destructive" aria-label="刪除">
                        <Trash2 size={14} />
                      </button>
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

/** "1234.5" → 123450。只接受已通過 amountValid 檢查的字串,用字串拆整數/小數避免浮點誤差。 */
function toCents(input: string): number {
  const [whole, frac = ""] = input.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

export default function WarrantyPage() {
  return (
    <Suspense fallback={null}>
      <WarrantyRoot />
    </Suspense>
  );
}
