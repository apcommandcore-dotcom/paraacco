"use client";

// 管理後台(規格 3.7)—— 供應商主檔(直接影響覆核規則——未登記的供應商一律強制送人工
// 覆核,見 packages/domain/src/vendor-matching.ts)、分類樹、歸屬移轉、成員(唯讀)。
// OCR 規則沒有做——目前系統裡完全沒有「OCR 規則」這個資料模型/規格(不是漏做,是這個
// 概念在規格文件、schema、API 都不存在),先列一個說明區塊,不要憑空發明一個沒人要求過
// 的資料表,見 CODE_TASK_post-golive-hardening_20260905.md 任務 10 的執行紀錄。

import { useEffect, useState } from "react";
import { Plus, Check, X } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch } from "@/lib/api";

type Tab = "vendors" | "categories" | "transfers" | "members" | "ocr-rules";
const TABS: { key: Tab; label: string }[] = [
  { key: "vendors", label: "供應商主檔" },
  { key: "categories", label: "分類樹" },
  { key: "transfers", label: "歸屬移轉" },
  { key: "members", label: "成員" },
  { key: "ocr-rules", label: "OCR 規則" },
];

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>("vendors");

  return (
    <AppShell>
      <h1 className="mb-4 text-xl font-semibold tracking-wide">管理</h1>
      <div className="mb-6 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`border px-3 py-1.5 text-sm ${
              tab === t.key ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-accent"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "vendors" && <VendorsTab />}
      {tab === "categories" && <CategoriesTab />}
      {tab === "transfers" && <TransfersTab />}
      {tab === "members" && <MembersTab />}
      {tab === "ocr-rules" && <OcrRulesTab />}
    </AppShell>
  );
}

// --- 供應商主檔 ---

interface Vendor {
  id: string;
  name: string;
  taxId: string | null;
  defaultOwnership: string;
  aliases: string[];
}

function VendorsTab() {
  const [vendors, setVendors] = useState<Vendor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", taxId: "" });
  const [submitting, setSubmitting] = useState(false);

  function load() {
    apiFetch<{ vendors: Vendor[] }>("/api/vendors")
      .then((d) => setVendors(d.vendors))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(load, []);

  async function addVendor() {
    if (!form.name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const id = `vnd-${form.name.trim().toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").slice(0, 40)}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      await apiFetch("/api/vendors", {
        method: "POST",
        body: JSON.stringify({ id, name: form.name.trim(), taxId: form.taxId.trim() || undefined, defaultOwnership: "corp" }),
      });
      setForm({ name: "", taxId: "" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>供應商主檔</CardTitle>
      </CardHeader>
      <CardContent>
        {error && <div className="mb-4 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">{error}</div>}
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">名稱</label>
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="w-56" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">統一編號(選填)</label>
            <Input value={form.taxId} onChange={(e) => setForm((f) => ({ ...f, taxId: e.target.value }))} className="w-32" maxLength={8} />
          </div>
          <Button size="sm" disabled={submitting || !form.name.trim()} onClick={addVendor}>
            <Plus size={14} className="mr-1" />
            新增供應商
          </Button>
        </div>

        {vendors === null && <div className="text-sm text-muted-foreground">載入中…</div>}
        {vendors && vendors.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名稱</TableHead>
                <TableHead>統編</TableHead>
                <TableHead>預設歸屬</TableHead>
                <TableHead>別名</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vendors.map((v) => (
                <TableRow key={v.id}>
                  <TableCell>{v.name}</TableCell>
                  <TableCell className="font-mono text-xs">{v.taxId ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{v.defaultOwnership}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{v.aliases.join("、") || "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {vendors?.length === 0 && <p className="text-sm text-muted-foreground">還沒有登記任何供應商。</p>}
      </CardContent>
    </Card>
  );
}

// --- 分類樹 ---

interface Category {
  id: string;
  ownershipScope: string;
  parentId: string | null;
  name: string;
}

function CategoriesTab() {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", ownershipScope: "corp", parentId: "" });
  const [submitting, setSubmitting] = useState(false);

  function load() {
    apiFetch<{ categories: Category[] }>("/api/categories")
      .then((d) => setCategories(d.categories))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(load, []);

  async function addCategory() {
    if (!form.name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const id = `cat-${form.name.trim().toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").slice(0, 40)}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      await apiFetch("/api/categories", {
        method: "POST",
        body: JSON.stringify({
          id,
          name: form.name.trim(),
          ownershipScope: form.ownershipScope,
          parentId: form.parentId || undefined,
        }),
      });
      setForm({ name: "", ownershipScope: "corp", parentId: "" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // 樹狀縮排顯示——量體小,直接遞迴算深度就好,不用真的做互動式樹狀元件。
  function depthOf(cat: Category, all: Category[], seen = new Set<string>()): number {
    if (!cat.parentId || seen.has(cat.id)) return 0;
    const parent = all.find((c) => c.id === cat.parentId);
    if (!parent) return 0;
    return 1 + depthOf(parent, all, new Set(seen).add(cat.id));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>分類樹</CardTitle>
      </CardHeader>
      <CardContent>
        {error && <div className="mb-4 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">{error}</div>}
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">名稱</label>
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="w-48" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">範圍</label>
            <select
              value={form.ownershipScope}
              onChange={(e) => setForm((f) => ({ ...f, ownershipScope: e.target.value }))}
              className="h-9 border border-input bg-background px-2 text-sm"
            >
              <option value="corp">公司</option>
              <option value="per">個人</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">上層分類(選填)</label>
            <select
              value={form.parentId}
              onChange={(e) => setForm((f) => ({ ...f, parentId: e.target.value }))}
              className="h-9 w-48 border border-input bg-background px-2 text-sm"
            >
              <option value="">（無,頂層分類）</option>
              {categories?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <Button size="sm" disabled={submitting || !form.name.trim()} onClick={addCategory}>
            <Plus size={14} className="mr-1" />
            新增分類
          </Button>
        </div>

        {categories === null && <div className="text-sm text-muted-foreground">載入中…</div>}
        {categories?.length === 0 && <p className="text-sm text-muted-foreground">還沒有任何分類。</p>}
        {categories && categories.length > 0 && (
          <ul className="text-sm">
            {categories.map((c) => (
              <li key={c.id} className="border-b border-border py-1.5 last:border-0" style={{ paddingLeft: depthOf(c, categories) * 20 }}>
                {c.name} <span className="ml-2 text-xs text-muted-foreground">{c.ownershipScope}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// --- 歸屬移轉 ---

interface Transfer {
  id: string;
  targetType: "purchase" | "asset";
  targetId: string;
  fromOwnership: string;
  toOwnership: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  requestedByMemberId: string;
}

function TransfersTab() {
  const [transfers, setTransfers] = useState<Transfer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    apiFetch<{ transfers: Transfer[] }>("/api/transfers")
      .then((d) => setTransfers(d.transfers))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(load, []);

  async function decide(id: string, approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/transfers/${id}/decide`, { method: "POST", body: JSON.stringify({ approve }) });
      load();
    } catch (err) {
      // 常見情境:目前登入者的 scope 不是 personal_corp,後端會回 403——這是正確行為
      // (規格:只有負責人/管理者角色能決行),不是 bug,錯誤訊息原樣顯示讓使用者知道
      // 要換帳號決行。
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>歸屬移轉申請</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {error && <div className="m-4 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">{error}</div>}
        {transfers === null && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
        {transfers?.length === 0 && <div className="p-4 text-sm text-muted-foreground">還沒有任何移轉申請。</div>}
        {transfers && transfers.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>申請編號</TableHead>
                <TableHead>對象</TableHead>
                <TableHead>異動</TableHead>
                <TableHead>原因</TableHead>
                <TableHead>狀態</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transfers.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-mono text-xs">{t.id}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {t.targetType === "purchase" ? "採購案" : "資產"} {t.targetId}
                  </TableCell>
                  <TableCell className="text-xs">
                    {t.fromOwnership} → {t.toOwnership}
                  </TableCell>
                  <TableCell className="truncate text-xs">{t.reason}</TableCell>
                  <TableCell>
                    <Badge variant={t.status === "pending" ? "warning" : t.status === "approved" ? "success" : "outline"}>{t.status}</Badge>
                  </TableCell>
                  <TableCell>
                    {t.status === "pending" && (
                      <div className="flex gap-1">
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => decide(t.id, true)}>
                          <Check size={12} className="mr-1" />
                          核准
                        </Button>
                        <Button size="sm" variant="destructive" disabled={busy} onClick={() => decide(t.id, false)}>
                          <X size={12} className="mr-1" />
                          駁回
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// --- 成員 ---

interface Member {
  id: string;
  email: string;
  name: string;
  role: string;
  scope: string;
  status: string;
}

function MembersTab() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ members: Member[] }>("/api/members")
      .then((d) => setMembers(d.members))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>成員(唯讀)</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {error && <div className="m-4 border border-destructive-line bg-destructive-bg p-3 text-sm text-destructive">{error}</div>}
        {members === null && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
        {members && members.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>姓名</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>權限範圍</TableHead>
                <TableHead>狀態</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{m.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{m.email}</TableCell>
                  <TableCell className="text-xs">{m.role}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{m.scope}</TableCell>
                  <TableCell className="text-xs">{m.status}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// --- OCR 規則(說明區塊,沒有實作)---

function OcrRulesTab() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>OCR 規則</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        <p className="mb-2">
          目前系統裡沒有「OCR 規則」這個資料模型——規格文件、`packages/db` 的 schema、`apps/api`
          都沒有定義過這個概念(OCR 供應商選型、prompt 內容目前是寫死在
          `packages/ocr/src/gemini-provider.ts`/`extraction-prompt.ts` 裡的程式碼,不是可以在
          管理後台調整的資料)。
        </p>
        <p>
          與其憑空發明一套沒人要求過的規則引擎資料表,這裡先留白說明現況——如果之後真的需要
          「依供應商/文件類型自訂擷取規則」這種功能,需要先定義清楚資料模型長什麼樣子(規則
          比對條件、覆蓋哪些欄位、跟現有 prompt 的關係),再排時間做,不適合在這次任務裡臨時
          決定。
        </p>
      </CardContent>
    </Card>
  );
}
