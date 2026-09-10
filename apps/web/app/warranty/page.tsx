"use client";

// 保固與訂閱(2026-09-07 補完設計落差任務書任務 3)—— 列表依到期日排序、即將到期用警示色,
// 支援新增/編輯/刪除。狀態(使用中/即將到期/已過期)是後端即時算的(見
// apps/api/src/routes/warranty.ts),這裡直接顯示,不重算。
//
// 2026-09-10 資產欄位對齊任務書任務 2:支援從資產詳情頁跳轉過來——
// ?entityId=<assetId> 篩選只看該資產掛的紀錄(對應「點保固狀態導到這裡」);
// ?newEntityType=asset&newEntityId=<assetId>&newOwnership=<scope> 預先帶入新增表單並
// 自動展開(對應「還沒有保固紀錄時顯示 + 新增保固」)。

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
  WARRANTY_STATUS_LABELS,
  type OwnershipScope,
  type WarrantyItem,
  type WarrantyStatus,
} from "@/lib/api";

function statusVariant(status: WarrantyStatus): "success" | "warning" | "destructive" {
  if (status === "expired") return "destructive";
  if (status === "due_soon") return "warning";
  return "success";
}

function emptyForm(entityType: "" | "asset" = "", entityId = "", ownership: OwnershipScope = "corp") {
  return {
    name: "",
    type: "warranty" as "warranty" | "subscription",
    vendorName: "",
    ownership,
    endDate: "",
    renewalCycle: "one_time" as "one_time" | "monthly" | "quarterly" | "yearly",
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

  const displayItems = filterEntityId ? (items ?? []).filter((i) => i.entityId === filterEntityId) : items;

  async function addItem() {
    if (!form.name.trim() || !form.endDate) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/api/warranty", {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          type: form.type,
          vendorName: form.vendorName.trim() || undefined,
          ownership: form.ownership,
          endDate: form.endDate,
          renewalCycle: form.renewalCycle,
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
    if (!confirm("確定要刪除這筆保固/訂閱紀錄嗎?")) return;
    await apiFetch(`/api/warranty/${id}/delete`, { method: "POST" }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    load();
  }

  return (
    <AppShell>
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-baseline gap-2.5">
          <h1 className="m-0 text-[23px] font-extrabold tracking-tight">保固與訂閱</h1>
          <span className="font-mono text-[10px] tracking-[0.16em] text-foreground-3">COVERAGE</span>
        </div>
        <Button size="sm" onClick={() => setShowForm((v) => !v)}>
          <Plus size={14} className="mr-1" />
          新增
        </Button>
      </div>
      <p className="mb-5 text-sm text-foreground-2">保固到期、軟體訂閱續約提醒——可以獨立存在,不用一定要掛在某個資產上。</p>

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
            <CardTitle>新增保固/訂閱</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="名稱">
                <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="w-48" />
              </Field>
              <Field label="類型">
                <select
                  value={form.type}
                  onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as typeof f.type }))}
                  className="h-9 border border-input bg-background px-2 text-sm"
                >
                  <option value="warranty">保固</option>
                  <option value="subscription">訂閱</option>
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
              <Field label="到期日">
                <Input type="date" value={form.endDate} onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} className="w-40" />
              </Field>
              <Field label="週期">
                <select
                  value={form.renewalCycle}
                  onChange={(e) => setForm((f) => ({ ...f, renewalCycle: e.target.value as typeof f.renewalCycle }))}
                  className="h-9 border border-input bg-background px-2 text-sm"
                >
                  <option value="one_time">一次性</option>
                  <option value="monthly">每月</option>
                  <option value="quarterly">每季</option>
                  <option value="yearly">每年</option>
                </select>
              </Field>
              <Field label="提醒天數">
                <Input
                  type="number"
                  value={form.reminderDaysBefore}
                  onChange={(e) => setForm((f) => ({ ...f, reminderDaysBefore: e.target.value }))}
                  className="w-24"
                />
              </Field>
              <Button size="sm" disabled={submitting || !form.name.trim() || !form.endDate} onClick={addItem}>
                儲存
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {displayItems === null && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
          {displayItems?.length === 0 && <div className="p-4 text-sm text-muted-foreground">還沒有任何保固/訂閱紀錄。</div>}
          {displayItems && displayItems.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名稱</TableHead>
                  <TableHead>類型</TableHead>
                  <TableHead>供應商</TableHead>
                  <TableHead>範圍</TableHead>
                  <TableHead>到期日</TableHead>
                  <TableHead>狀態</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayItems.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{item.type === "warranty" ? "保固" : "訂閱"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{item.vendorName ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{OWNERSHIP_LABELS[item.ownership]}</TableCell>
                    <TableCell className="font-mono text-xs">{item.endDate}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(item.status)}>{WARRANTY_STATUS_LABELS[item.status]}</Badge>
                    </TableCell>
                    <TableCell>
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
