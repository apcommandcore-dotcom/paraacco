"use client";

// 管理後台 › 品項類別(2026-10-01,CODE_TASK_purchase-object-merge-docs_20260929_V1.02.md 7.3、7.4)——
//   類別:名稱、代碼、對應會計科目、預設歸屬、啟用/停用、排序(拖曳或 ↑↓)、顏色;一層子類別;
//         已被品項使用的類別不能刪,只能停用(停用後舊品項保留原類別,右鍵選單不再出現)。
//   自動規則:「記住此分類」建立的規則(賣方統編 + 品名關鍵字 → 類別/歸屬/專案);可停用/刪除,刪除不改動已套用的品項。
//   請款對象:代墊的請款對象清單(業主/公司/其他…)。

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { AdminNav } from "@/components/admin-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { apiFetch, OWNERSHIP_LABELS, type AdvancePayee, type ItemCategory, type ItemRule, type OwnershipScope } from "@/lib/api";

type Tab = "categories" | "rules" | "payees";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "categories", label: "類別" },
  { key: "rules", label: "自動規則" },
  { key: "payees", label: "代墊請款對象" },
];

export default function ItemCategoriesAdminPage() {
  const [tab, setTab] = useState<Tab>("categories");
  const [categories, setCategories] = useState<ItemCategory[]>([]);
  const [rules, setRules] = useState<ItemRule[]>([]);
  const [payees, setPayees] = useState<AdvancePayee[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      apiFetch<{ categories: ItemCategory[] }>("/api/item-categories"),
      apiFetch<{ rules: ItemRule[] }>("/api/item-rules"),
      apiFetch<{ payees: AdvancePayee[] }>("/api/advance-payees"),
    ])
      .then(([c, r, p]) => {
        setCategories(c.categories);
        setRules(r.rules);
        setPayees(p.payees);
      })
      .catch((err) => setMessage(err instanceof Error ? err.message : String(err)));
  }, []);
  useEffect(load, [load]);

  async function act(path: string, body: unknown, ok?: string) {
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch(path, { method: "POST", body: JSON.stringify(body) });
      if (ok) setMessage(ok);
      load();
      return true;
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      try {
        setMessage((JSON.parse(text) as { message?: string; error?: string; field?: string }).message ?? text);
      } catch {
        setMessage(text);
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <h1 className="mb-4 text-xl font-semibold tracking-wide">管理 — 品項類別</h1>
      <AdminNav />
      <div className="mb-4 flex gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`border px-3 py-1 text-xs ${tab === t.key ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-accent"}`}
          >
            {t.label}
            {t.key === "rules" && rules.length > 0 && <span className="ml-1">({rules.length})</span>}
          </button>
        ))}
      </div>
      {message && <div className="mb-3 border border-line bg-muted px-3 py-2 text-xs">{message}</div>}
      {tab === "categories" && <CategoriesTab categories={categories} busy={busy} act={act} />}
      {tab === "rules" && <RulesTab rules={rules} categories={categories} busy={busy} act={act} />}
      {tab === "payees" && <PayeesTab payees={payees} busy={busy} act={act} />}
    </AppShell>
  );
}

type Act = (path: string, body: unknown, ok?: string) => Promise<boolean>;

function CategoriesTab({ categories, busy, act }: { categories: ItemCategory[]; busy: boolean; act: Act }) {
  const [form, setForm] = useState({ name: "", code: "", parentId: "", accountTitle: "", defaultOwnership: "", color: "" });
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState({ name: "", code: "", accountTitle: "", defaultOwnership: "", color: "" });
  const [dragId, setDragId] = useState<string | null>(null);
  const parents = categories.filter((c) => !c.parentId);
  // 顯示順序:父類別依 sort_order,子類別緊接在父類別下
  const ordered = parents.flatMap((p) => [p, ...categories.filter((c) => c.parentId === p.id)]);
  const orphans = categories.filter((c) => c.parentId && !parents.some((p) => p.id === c.parentId));

  function reorder(ids: string[]) {
    return act("/api/item-categories/reorder", { ids });
  }
  function move(id: string, dir: -1 | 1) {
    const cat = categories.find((c) => c.id === id)!;
    const siblings = categories.filter((c) => (c.parentId ?? null) === (cat.parentId ?? null));
    const i = siblings.findIndex((c) => c.id === id);
    const j = i + dir;
    if (j < 0 || j >= siblings.length) return;
    const ids = siblings.map((c) => c.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    return reorder(ids);
  }
  function drop(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const a = categories.find((c) => c.id === dragId)!;
    const b = categories.find((c) => c.id === targetId)!;
    if ((a.parentId ?? null) !== (b.parentId ?? null)) return; // 只在同一層內排序
    const ids = categories.filter((c) => (c.parentId ?? null) === (a.parentId ?? null)).map((c) => c.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    return reorder(ids);
  }
  const sel = "h-8 border border-input bg-background px-1.5 text-xs";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>類別({categories.filter((c) => c.isActive).length} 個啟用)</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-xs text-muted-foreground">
            拖曳或按 ↑↓ 排序(同一層內)。被品項用過的類別不能刪除,只能停用;停用後已套用的品項仍顯示原類別,但右鍵選單不再出現。子類別只有一層。
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line text-left text-foreground-3">
                <th className="py-1 font-normal" />
                <th className="py-1 font-normal">名稱</th>
                <th className="py-1 font-normal">代碼</th>
                <th className="py-1 font-normal">對應會計科目</th>
                <th className="py-1 font-normal">預設歸屬</th>
                <th className="py-1 text-right font-normal">使用中品項</th>
                <th className="py-1 font-normal">狀態</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...ordered, ...orphans].map((c) => (
                <tr
                  key={c.id}
                  draggable
                  onDragStart={() => setDragId(c.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => drop(c.id)}
                  className={`border-b border-line-2 ${c.isActive ? "" : "text-foreground-3"}`}
                >
                  <td className="w-12 cursor-grab whitespace-nowrap py-1 text-foreground-3">
                    ⋮⋮
                    <button type="button" disabled={busy} className="ml-1 hover:text-foreground" onClick={() => move(c.id, -1)} aria-label="上移">
                      ↑
                    </button>
                    <button type="button" disabled={busy} className="hover:text-foreground" onClick={() => move(c.id, 1)} aria-label="下移">
                      ↓
                    </button>
                  </td>
                  {editing === c.id ? (
                    <>
                      <td className="py-1">
                        <Input value={edit.name} onChange={(e) => setEdit((f) => ({ ...f, name: e.target.value }))} className="h-7 text-xs" />
                      </td>
                      <td className="py-1">
                        <Input value={edit.code} onChange={(e) => setEdit((f) => ({ ...f, code: e.target.value }))} className="h-7 w-20 text-xs" />
                      </td>
                      <td className="py-1">
                        <Input value={edit.accountTitle} onChange={(e) => setEdit((f) => ({ ...f, accountTitle: e.target.value }))} className="h-7 text-xs" />
                      </td>
                      <td className="py-1">
                        <select value={edit.defaultOwnership} onChange={(e) => setEdit((f) => ({ ...f, defaultOwnership: e.target.value }))} className={sel}>
                          <option value="">(不指定)</option>
                          {(Object.keys(OWNERSHIP_LABELS) as OwnershipScope[]).map((k) => (
                            <option key={k} value={k}>
                              {OWNERSHIP_LABELS[k]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td />
                      <td />
                      <td className="whitespace-nowrap py-1">
                        <Button
                          size="sm"
                          disabled={busy || !edit.name.trim()}
                          onClick={async () => {
                            if (await act(`/api/item-categories/${c.id}`, { ...edit, defaultOwnership: edit.defaultOwnership || null }, "已儲存")) setEditing(null);
                          }}
                        >
                          儲存
                        </Button>
                        <button type="button" className="ml-2 text-foreground-3 hover:underline" onClick={() => setEditing(null)}>
                          取消
                        </button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className={`py-1 ${c.parentId ? "pl-5" : "font-medium"}`}>
                        {c.parentId ? "└ " : ""}
                        {c.color && <span className="mr-1 inline-block h-2 w-2 align-middle" style={{ background: c.color }} />}
                        {c.name}
                      </td>
                      <td className="py-1 font-mono">{c.code ?? ""}</td>
                      <td className="py-1">{c.accountTitle ?? ""}</td>
                      <td className="py-1">{c.defaultOwnership ? OWNERSHIP_LABELS[c.defaultOwnership] : ""}</td>
                      <td className="py-1 text-right font-mono">{c.usedCount || ""}</td>
                      <td className="py-1">{c.isActive ? <Badge variant="success">啟用</Badge> : <Badge variant="outline">停用</Badge>}</td>
                      <td className="whitespace-nowrap py-1 text-right">
                        <button
                          type="button"
                          className="text-primary hover:underline"
                          onClick={() => {
                            setEditing(c.id);
                            setEdit({ name: c.name, code: c.code ?? "", accountTitle: c.accountTitle ?? "", defaultOwnership: c.defaultOwnership ?? "", color: c.color ?? "" });
                          }}
                        >
                          編輯
                        </button>
                        <button type="button" disabled={busy} className="ml-2 hover:underline" onClick={() => act(`/api/item-categories/${c.id}`, { isActive: !c.isActive }, c.isActive ? `已停用「${c.name}」` : `已啟用「${c.name}」`)}>
                          {c.isActive ? "停用" : "啟用"}
                        </button>
                        {!c.usedCount && (
                          <button type="button" disabled={busy} className="ml-2 text-destructive hover:underline" onClick={() => confirm(`刪除類別「${c.name}」?`) && act(`/api/item-categories/${c.id}/delete`, {}, `已刪除「${c.name}」`)}>
                            刪除
                          </button>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>新增類別</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-2 text-xs">
            <label>
              <span className="mb-1 block text-muted-foreground">名稱 *</span>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="h-8 w-36 text-xs" />
            </label>
            <label>
              <span className="mb-1 block text-muted-foreground">上層類別(子類別用)</span>
              <select value={form.parentId} onChange={(e) => setForm((f) => ({ ...f, parentId: e.target.value }))} className={sel}>
                <option value="">(無,建立第一層)</option>
                {parents.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1 block text-muted-foreground">代碼</span>
              <Input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} className="h-8 w-20 text-xs" />
            </label>
            <label>
              <span className="mb-1 block text-muted-foreground">對應會計科目</span>
              <Input value={form.accountTitle} onChange={(e) => setForm((f) => ({ ...f, accountTitle: e.target.value }))} className="h-8 w-32 text-xs" />
            </label>
            <label>
              <span className="mb-1 block text-muted-foreground">預設歸屬</span>
              <select value={form.defaultOwnership} onChange={(e) => setForm((f) => ({ ...f, defaultOwnership: e.target.value }))} className={sel}>
                <option value="">(不指定)</option>
                {(Object.keys(OWNERSHIP_LABELS) as OwnershipScope[]).map((k) => (
                  <option key={k} value={k}>
                    {OWNERSHIP_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1 block text-muted-foreground">顏色</span>
              <input type="color" value={form.color || "#888888"} onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))} className="h-8 w-10 border border-input" />
            </label>
            <Button
              size="sm"
              disabled={busy || !form.name.trim()}
              onClick={async () => {
                if (await act("/api/item-categories", { ...form, parentId: form.parentId || null, defaultOwnership: form.defaultOwnership || null, color: form.color || null }, `已新增「${form.name}」`))
                  setForm({ name: "", code: "", parentId: "", accountTitle: "", defaultOwnership: "", color: "" });
              }}
            >
              新增
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function RulesTab({ rules, categories, busy, act }: { rules: ItemRule[]; categories: ItemCategory[]; busy: boolean; act: Act }) {
  const catName = (id: string | null) => (id ? (categories.find((c) => c.id === id)?.name ?? id) : "");
  return (
    <Card>
      <CardHeader>
        <CardTitle>自動規則</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-xs text-muted-foreground">
          在品項右鍵選單勾「記住此分類」就會建立規則:之後同賣方統編的新進件擷取出品項時自動套用,標「自動」,覆核時可一鍵改回。
          多條規則都符合時,有品名關鍵字(較具體)的優先,再以最新建立的優先。停用或刪除規則不會改動已經套用的品項。
        </p>
        {rules.length === 0 ? (
          <div className="text-xs text-muted-foreground">還沒有規則。</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line text-left text-foreground-3">
                <th className="py-1 font-normal">#</th>
                <th className="py-1 font-normal">賣方統編</th>
                <th className="py-1 font-normal">品名關鍵字</th>
                <th className="py-1 font-normal">→ 類別</th>
                <th className="py-1 font-normal">→ 歸屬</th>
                <th className="py-1 font-normal">→ 專案</th>
                <th className="py-1 font-normal">建立</th>
                <th className="py-1 font-normal">狀態</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className={`border-b border-line-2 ${r.isActive ? "" : "text-foreground-3"}`}>
                  <td className="py-1 font-mono">{r.id}</td>
                  <td className="py-1 font-mono">{r.vendorTaxId}</td>
                  <td className="py-1">{r.nameKeyword ?? <span className="text-foreground-3">(全部品項)</span>}</td>
                  <td className="py-1">{catName(r.categoryId)}</td>
                  <td className="py-1">{r.ownership ? OWNERSHIP_LABELS[r.ownership] : ""}</td>
                  <td className="py-1 font-mono">{r.projectCode ?? ""}</td>
                  <td className="py-1">{r.createdAt.slice(0, 10)}</td>
                  <td className="py-1">{r.isActive ? <Badge variant="success">啟用</Badge> : <Badge variant="outline">停用</Badge>}</td>
                  <td className="whitespace-nowrap py-1 text-right">
                    <button type="button" disabled={busy} className="hover:underline" onClick={() => act(`/api/item-rules/${r.id}`, { isActive: !r.isActive })}>
                      {r.isActive ? "停用" : "啟用"}
                    </button>
                    <button type="button" disabled={busy} className="ml-2 text-destructive hover:underline" onClick={() => confirm(`刪除規則 #${r.id}?已套用的品項不會改動。`) && act(`/api/item-rules/${r.id}/delete`, {}, `已刪除規則 #${r.id}`)}>
                      刪除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function PayeesTab({ payees, busy, act }: { payees: AdvancePayee[]; busy: boolean; act: Act }) {
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>代墊請款對象</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <p className="text-muted-foreground">品項右鍵「代墊」時選擇的請款對象;對帳頁「代墊未請回」依此分組。停用後不再出現在選單,已標記的品項不受影響。</p>
        <table className="w-full">
          <tbody>
            {payees.map((p) => (
              <tr key={p.id} className={`border-b border-line-2 ${p.isActive ? "" : "text-foreground-3"}`}>
                <td className="py-1">
                  {editing?.id === p.id ? (
                    <Input value={editing.name} onChange={(e) => setEditing({ id: p.id, name: e.target.value })} className="h-7 w-48 text-xs" />
                  ) : (
                    p.name
                  )}
                </td>
                <td className="py-1">{p.isActive ? <Badge variant="success">啟用</Badge> : <Badge variant="outline">停用</Badge>}</td>
                <td className="whitespace-nowrap py-1 text-right">
                  {editing?.id === p.id ? (
                    <button
                      type="button"
                      disabled={busy || !editing.name.trim()}
                      className="text-primary hover:underline"
                      onClick={async () => {
                        if (await act(`/api/advance-payees/${p.id}`, { name: editing.name })) setEditing(null);
                      }}
                    >
                      儲存
                    </button>
                  ) : (
                    <button type="button" className="text-primary hover:underline" onClick={() => setEditing({ id: p.id, name: p.name })}>
                      改名
                    </button>
                  )}
                  <button type="button" disabled={busy} className="ml-2 hover:underline" onClick={() => act(`/api/advance-payees/${p.id}`, { isActive: !p.isActive })}>
                    {p.isActive ? "停用" : "啟用"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex items-end gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="新的請款對象" className="h-8 w-48 text-xs" />
          <Button
            size="sm"
            disabled={busy || !name.trim()}
            onClick={async () => {
              if (await act("/api/advance-payees", { name }, `已新增「${name}」`)) setName("");
            }}
          >
            新增
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
