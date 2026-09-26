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
import {
  apiFetch,
  OWNERSHIP_LABELS,
  PAYMENT_METHOD_LABELS,
  RENEWAL_CYCLE_LABELS,
  WARRANTY_CATEGORY_LABELS,
  WARRANTY_STATUS_LABELS,
  WARRANTY_TYPE_LABELS,
  type OwnershipScope,
  type PaymentMethod,
  type RenewalCycle,
  type WarrantyItem,
  type WarrantyStatus,
  type WarrantyType,
} from "@/lib/api";

// 定期繳費的「過期」語意是「逾期未繳」,措辭跟保固的「已過期」分開。
function statusLabel(item: WarrantyItem): string {
  if (item.type === "recurring_bill") {
    if (item.status === "expired") return "逾期未繳";
    if (item.status === "due_soon") return "即將繳費";
    return "未到期";
  }
  return WARRANTY_STATUS_LABELS[item.status];
}

function formatAmount(cents: number | null): string {
  if (cents === null) return "—";
  return `$${(cents / 100).toLocaleString("zh-TW", { maximumFractionDigits: 2 })}`;
}

// 各類型建議的預設分類與週期,切換類型時帶入(使用者仍可改)。
const TYPE_DEFAULTS: Record<WarrantyType, { category: string; renewalCycle: RenewalCycle; reminderDaysBefore: string }> = {
  warranty: { category: "device", renewalCycle: "one_time", reminderDaysBefore: "30" },
  subscription: { category: "software", renewalCycle: "monthly", reminderDaysBefore: "7" },
  recurring_bill: { category: "water", renewalCycle: "bimonthly", reminderDaysBefore: "7" },
};

type TypeFilter = "all" | WarrantyType;

function statusVariant(status: WarrantyStatus): "success" | "warning" | "destructive" {
  if (status === "expired") return "destructive";
  if (status === "due_soon") return "warning";
  return "success";
}

function emptyForm(entityType: "" | "asset" = "", entityId = "", ownership: OwnershipScope = "corp") {
  return {
    name: "",
    type: "warranty" as WarrantyType,
    category: "device",
    vendorName: "",
    ownership,
    endDate: "",
    renewalCycle: "one_time" as RenewalCycle,
    amount: "",
    paymentMethod: "" as "" | PaymentMethod,
    accountRef: "",
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
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");

  const filterEntityId = searchParams.get("entityId");
  const newEntityId = searchParams.get("newEntityId");

  function load() {
    const path = scope ? `/api/warranty?ownership=${scope}` : "/api/warranty";
    apiFetch<{ items: WarrantyItem[] }>(path)
      .then((d) => setItems(d.items))
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

  const displayItems = items
    ? items.filter((i) => (!filterEntityId || i.entityId === filterEntityId) && (typeFilter === "all" || i.type === typeFilter))
    : null;
  const typeCounts = (items ?? []).reduce<Record<string, number>>((acc, i) => ((acc[i.type] = (acc[i.type] ?? 0) + 1), acc), {});

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
          type: form.type,
          category: form.category || undefined,
          vendorName: form.vendorName.trim() || undefined,
          ownership: form.ownership,
          endDate: form.endDate,
          renewalCycle: form.renewalCycle,
          // 元 → 整數分(字串運算,避免 0.1+0.2 這類浮點誤差)
          amountCents: form.amount.trim() ? toCents(form.amount.trim()) : undefined,
          paymentMethod: form.paymentMethod || undefined,
          accountRef: form.accountRef.trim() || undefined,
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

  async function markPaid(item: WarrantyItem) {
    if (!confirm(`「${item.name}」${item.endDate} 這期已繳?到期日會推到下一期(${RENEWAL_CYCLE_LABELS[item.renewalCycle]})。`)) return;
    await apiFetch(`/api/warranty/${item.id}/advance`, { method: "POST", body: JSON.stringify({}) }).catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
    load();
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
          <h1 className="m-0 text-[23px] font-extrabold tracking-tight">保固、訂閱與定期繳費</h1>
          <span className="font-mono text-[10px] tracking-[0.16em] text-foreground-3">COVERAGE</span>
        </div>
        <Button size="sm" onClick={() => setShowForm((v) => !v)}>
          <Plus size={14} className="mr-1" />
          新增
        </Button>
      </div>
      <p className="mb-4 text-sm text-foreground-2">保固到期、軟體訂閱續約,以及水電、網路、瓦斯、勞健保、稅金等定期繳費提醒——可以獨立存在,不用一定要掛在某個資產上。</p>

      <div className="mb-4 flex gap-1 border-b border-line-2">
        {(["all", "recurring_bill", "subscription", "warranty"] as TypeFilter[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTypeFilter(t)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${typeFilter === t ? "border-foreground font-semibold" : "border-transparent text-foreground-2 hover:text-foreground"}`}
          >
            {t === "all" ? "全部" : WARRANTY_TYPE_LABELS[t]}
            <span className="ml-1 font-mono text-[10px] text-foreground-3">{t === "all" ? (items?.length ?? 0) : (typeCounts[t] ?? 0)}</span>
          </button>
        ))}
      </div>

      {filterEntityId && (
        <div className="mb-4 flex items-center justify-between border border-line-2 bg-surface-2 p-3 text-sm">
          <span>正在檢視資產 <span className="font-mono text-xs">{filterEntityId}</span> 掛的保固/訂閱紀錄</span>
          <button type="button" className="text-xs text-primary hover:underline" onClick={() => router.push("/warranty")}>
            看全部
          </button>
        </div>
      )}

      {error && <div className="mb-4 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">{error}</div>}

      {showForm && (
        <Card className="mb-5">
          <CardHeader>
            <CardTitle>新增保固/訂閱/定期繳費</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="名稱">
                <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="w-48" />
              </Field>
              <Field label="類型">
                <select
                  value={form.type}
                  onChange={(e) => {
                    const type = e.target.value as WarrantyType;
                    setForm((f) => ({ ...f, type, ...TYPE_DEFAULTS[type] }));
                  }}
                  className="h-9 border border-input bg-background px-2 text-sm"
                >
                  {(Object.keys(WARRANTY_TYPE_LABELS) as WarrantyType[]).map((k) => (
                    <option key={k} value={k}>
                      {WARRANTY_TYPE_LABELS[k]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="分類">
                <select
                  value={form.category}
                  onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                  className="h-9 border border-input bg-background px-2 text-sm"
                >
                  {Object.entries(WARRANTY_CATEGORY_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
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
              <Field label={form.type === "recurring_bill" ? "下次繳費期限" : "到期日"}>
                <Input type="date" value={form.endDate} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} className="w-40" />
              </Field>
              <Field label="週期">
                <select
                  value={form.renewalCycle}
                  onChange={(e) => setForm((f) => ({ ...f, renewalCycle: e.target.value as typeof f.renewalCycle }))}
                  className="h-9 border border-input bg-background px-2 text-sm"
                >
                  {(Object.keys(RENEWAL_CYCLE_LABELS) as RenewalCycle[]).map((k) => (
                    <option key={k} value={k}>
                      {RENEWAL_CYCLE_LABELS[k]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="金額(元,選填)">
                <Input
                  inputMode="decimal"
                  value={form.amount}
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                  className={`w-28 ${amountValid ? "" : "border-destructive"}`}
                />
              </Field>
              <Field label="繳費方式(選填)">
                <select
                  value={form.paymentMethod}
                  onChange={(e) => setForm((f) => ({ ...f, paymentMethod: e.target.value as "" | PaymentMethod }))}
                  className="h-9 border border-input bg-background px-2 text-sm"
                >
                  <option value="">—</option>
                  {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((k) => (
                    <option key={k} value={k}>
                      {PAYMENT_METHOD_LABELS[k]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="用戶號碼/電號(選填)">
                <Input value={form.accountRef} onChange={(e) => setForm((f) => ({ ...f, accountRef: e.target.value }))} className="w-40" />
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

      <Card>
        <CardContent className="p-0">
          {displayItems === null && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
          {displayItems?.length === 0 && <div className="p-4 text-sm text-muted-foreground">這個分類還沒有任何紀錄。</div>}
          {displayItems && displayItems.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名稱</TableHead>
                  <TableHead>類型</TableHead>
                  <TableHead>分類</TableHead>
                  <TableHead>供應商</TableHead>
                  <TableHead>範圍</TableHead>
                  <TableHead>週期</TableHead>
                  <TableHead className="text-right">金額</TableHead>
                  <TableHead>到期/繳費日</TableHead>
                  <TableHead>狀態</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayItems.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="max-w-[200px] truncate">{item.name}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{WARRANTY_TYPE_LABELS[item.type] ?? item.type}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {item.category ? (WARRANTY_CATEGORY_LABELS[item.category] ?? item.category) : "—"}
                    </TableCell>
                    <TableCell className="max-w-[140px] truncate text-xs text-muted-foreground" title={item.accountRef ?? undefined}>
                      {item.vendorName ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{OWNERSHIP_LABELS[item.ownership]}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {RENEWAL_CYCLE_LABELS[item.renewalCycle] ?? item.renewalCycle}
                      {item.paymentMethod && <span className="ml-1 text-foreground-3">· {PAYMENT_METHOD_LABELS[item.paymentMethod]}</span>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono text-xs">{formatAmount(item.amountCents)}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{item.endDate}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(item.status)}>{statusLabel(item)}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {item.type !== "warranty" && item.renewalCycle !== "one_time" && (
                        <button
                          type="button"
                          onClick={() => markPaid(item)}
                          className="mr-3 text-xs text-primary hover:underline"
                          title="這期已繳,到期日推到下一期"
                        >
                          已繳
                        </button>
                      )}
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
