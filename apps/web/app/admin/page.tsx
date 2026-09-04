"use client";

// 管理後台(規格 3.7)—— Phase 5:先做「供應商主檔」(直接影響覆核規則——未登記的供應商
// 一律強制送人工覆核,見 packages/domain/src/vendor-matching.ts)+ 成員清單(唯讀)。
// 分類樹、OCR 規則、歸屬移轉先不做,量體大但不阻塞日常使用,直接查 D1/手動 SQL 頂著即可,
// 見 CODE_TASK_go-live-a2-a3-phase1_20260904.md Phase 5 範圍說明。

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiFetch } from "@/lib/api";

interface Vendor {
  id: string;
  name: string;
  taxId: string | null;
  defaultOwnership: string;
  aliases: string[];
}

interface Member {
  id: string;
  email: string;
  name: string;
  role: string;
  scope: string;
  status: string;
}

export default function AdminPage() {
  const [vendors, setVendors] = useState<Vendor[] | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", taxId: "" });
  const [submitting, setSubmitting] = useState(false);

  function loadVendors() {
    apiFetch<{ vendors: Vendor[] }>("/api/vendors")
      .then((d) => setVendors(d.vendors))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  useEffect(() => {
    loadVendors();
    apiFetch<{ members: Member[] }>("/api/members")
      .then((d) => setMembers(d.members))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

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
        body: JSON.stringify({
          id,
          name: form.name.trim(),
          taxId: form.taxId.trim() || undefined,
          defaultOwnership: "corp",
        }),
      });
      setForm({ name: "", taxId: "" });
      loadVendors();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell>
      <h1 className="mb-6 text-xl font-semibold tracking-wide">管理</h1>
      {error && <div className="mb-4 border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>供應商主檔</CardTitle>
        </CardHeader>
        <CardContent>
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

      <Card>
        <CardHeader>
          <CardTitle>成員(唯讀)</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
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

      <p className="mt-6 text-xs text-muted-foreground">
        分類樹、OCR 規則、歸屬移轉的管理介面還沒做——目前直接查 D1 / 手動 SQL 頂著,不急著在這個階段做完整
        Admin UI。
      </p>
    </AppShell>
  );
}
