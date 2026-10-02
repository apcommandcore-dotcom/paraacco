"use client";

// 品項右鍵選單(2026-10-01,CODE_TASK_purchase-object-merge-docs_20260929_V1.02.md 7.2)——
// 物件展開後的品項列按右鍵(可多選後一起套用;觸控裝置用列尾「⋯」開同一份選單):
//   費用類別(最近用過的置頂)/歸屬/指定專案(可搜尋、不屬於專案)/代墊(請款對象、已請回)/保固與資產/
//   修正品名(保留原始辨識值)/不列帳(需填原因)/記住此分類(賣方統編 + 品名關鍵字建自動規則)。
// 每次套用都走 POST /api/purchase-items/bulk(寫 activity_log + item_change_batches),選單底部與套用後的提示條可「復原」。
// 類別/請款對象一律來自管理後台(/admin/item-categories),這裡不寫死。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { apiFetch, OWNERSHIP_LABELS, type AdvancePayee, type ItemCategory, type OwnershipScope, type PurchaseItemRow } from "@/lib/api";

interface MenuData {
  categories: ItemCategory[]; // 全部(含停用,標籤顯示要用);選單只列啟用的
  payees: AdvancePayee[];
  projects: Array<{ id: string; name: string }>;
  recentCategoryIds: string[];
}

let cache: Promise<MenuData> | null = null;
function loadMenuData(force = false): Promise<MenuData> {
  if (!cache || force) {
    cache = Promise.all([
      apiFetch<{ categories: ItemCategory[] }>("/api/item-categories"),
      apiFetch<{ payees: AdvancePayee[] }>("/api/advance-payees"),
      apiFetch<{ projects: Array<{ id: string; name: string }> }>("/api/projects").catch(() => ({ projects: [] })),
      apiFetch<{ categoryIds: string[] }>("/api/purchase-items/recent-categories").catch(() => ({ categoryIds: [] })),
    ]).then(([c, p, pr, r]) => ({ categories: c.categories, payees: p.payees, projects: pr.projects, recentCategoryIds: r.categoryIds }));
    cache.catch(() => {
      cache = null;
    });
  }
  return cache;
}

/** 類別/請款對象/專案清單(模組層快取;套用後重新抓「最近使用」)。 */
export function useItemMenuData() {
  const [data, setData] = useState<MenuData | null>(null);
  const reload = useCallback((force = true) => loadMenuData(force).then(setData).catch(() => {}), []);
  useEffect(() => {
    loadMenuData().then(setData).catch(() => {});
  }, []);
  return { data, reload };
}

/** 品項列上的小標籤:`餐費`(自動規則帶入的標「自動」)、`AP_26001`、`代墊`、`不列帳`、`已改名`。 */
export function ItemTags({ item, data }: { item: PurchaseItemRow; data: MenuData | null }) {
  const cat = item.categoryId ? data?.categories.find((c) => c.id === item.categoryId) : null;
  const payee = item.advancePayee ? data?.payees.find((p) => p.id === item.advancePayee) : null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {item.categoryId && (
        <Badge variant="info" className="px-1 py-0 text-[10px]" title={cat && !cat.isActive ? "這個類別已停用" : undefined}>
          {cat?.name ?? item.categoryId}
          {item.categorySource === "rule" ? "・自動" : ""}
        </Badge>
      )}
      {item.projectCode && (
        <Badge variant="outline" className="px-1 py-0 font-mono text-[10px]">
          {item.projectCode}
        </Badge>
      )}
      {item.isAdvance && (
        <Badge variant={item.advanceSettledAt ? "outline" : "warning"} className="px-1 py-0 text-[10px]">
          代墊{payee ? `・${payee.name}` : ""}
          {item.advanceSettledAt ? "・已請回" : ""}
        </Badge>
      )}
      {item.excludeFromReport && (
        <Badge variant="destructive" className="px-1 py-0 text-[10px]" title={item.excludeReason ?? undefined}>
          不列帳
        </Badge>
      )}
      {item.nameOriginal && (
        <span className="text-[10px] text-foreground-3" title={`原始辨識品名:${item.nameOriginal}`}>
          (已改名)
        </span>
      )}
    </span>
  );
}

export interface MenuTarget {
  items: PurchaseItemRow[];
  x: number;
  y: number;
}

/** 開選單的狀態;onContextMenu / 「⋯」按鈕共用。 */
export function useItemMenu() {
  const [target, setTarget] = useState<MenuTarget | null>(null);
  const open = useCallback((items: PurchaseItemRow[], e: { clientX: number; clientY: number; preventDefault?: () => void }) => {
    e.preventDefault?.();
    setTarget({ items, x: e.clientX, y: e.clientY });
  }, []);
  return { target, open, close: () => setTarget(null) };
}

export function ItemMenuButton({ onOpen }: { onOpen: (e: React.MouseEvent) => void }) {
  return (
    <button type="button" aria-label="品項選單" className="px-1 text-foreground-3 hover:text-foreground" onClick={(e) => onOpen(e)}>
      <MoreHorizontal className="h-3.5 w-3.5" />
    </button>
  );
}

type Section = "category" | "ownership" | "project" | "advance" | "warranty" | "rename" | "exclude" | null;

/** 套用後的提示條(含「復原」);放在選單以外,選單關掉後仍可按。 */
export function UndoBar({ batchId, onUndone, onDismiss }: { batchId: number | null; onUndone: () => void; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!batchId) return null;
  return (
    <div className="flex items-center gap-2 border border-line bg-muted px-2 py-1 text-[11px]">
      已套用(批次 #{batchId})
      <button
        type="button"
        disabled={busy}
        className="text-primary hover:underline"
        onClick={async () => {
          setBusy(true);
          try {
            await apiFetch("/api/purchase-items/undo", { method: "POST", body: JSON.stringify({ batchId }) });
            onUndone();
          } finally {
            setBusy(false);
          }
        }}
      >
        復原
      </button>
      <button type="button" className="ml-auto text-foreground-3 hover:text-foreground" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}

export function ItemContextMenu({
  target,
  data,
  objectOwnership,
  onClose,
  onApplied,
}: {
  target: MenuTarget;
  data: MenuData | null;
  objectOwnership?: string | null;
  onClose: () => void;
  /** batchId = null 代表沒有可復原的批次(例:建立資產、規則改回以外的動作) */
  onApplied: (r: { batchId: number | null; message?: string }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<Section>(null);
  const [remember, setRemember] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [projectQ, setProjectQ] = useState("");
  const [reason, setReason] = useState("");
  const [rename, setRename] = useState(target.items[0]?.name ?? "");
  const [warranty, setWarranty] = useState({ start: target.items[0]?.warrantyStartDate ?? "", end: target.items[0]?.warrantyEndDate ?? "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const single = target.items.length === 1;
  const ids = target.items.map((i) => i.id);

  useEffect(() => {
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // 選單貼在游標處,超出視窗就往回推
  const [pos, setPos] = useState({ left: target.x, top: target.y });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(target.x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(target.y, window.innerHeight - r.height - 8)) });
  }, [target.x, target.y, section]);

  const activeCats = useMemo(() => (data?.categories ?? []).filter((c) => c.isActive), [data]);
  const orderedCats = useMemo(() => {
    const recent = (data?.recentCategoryIds ?? []).map((id) => activeCats.find((c) => c.id === id)).filter((c): c is ItemCategory => !!c);
    const parents = activeCats.filter((c) => !c.parentId);
    const rest = parents.flatMap((p) => [p, ...activeCats.filter((c) => c.parentId === p.id)]);
    return { recent, rest };
  }, [activeCats, data]);
  const projects = useMemo(() => {
    const q = projectQ.trim().toLowerCase();
    return (data?.projects ?? []).filter((p) => !q || p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)).slice(0, 12);
  }, [data, projectQ]);

  async function apply(set: Record<string, unknown>, withRule = false) {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<{ batchId: number | null; ruleId: number | null; ruleError: string | null }>("/api/purchase-items/bulk", {
        method: "POST",
        body: JSON.stringify({ itemIds: ids, set, ...(withRule && remember ? { rememberRule: { nameKeyword: keyword.trim() || null } } : {}) }),
      });
      const ruleMsg = withRule && remember ? (r.ruleId ? `,已記住規則 #${r.ruleId}` : `,規則沒建立(${r.ruleError === "vendorTaxId" ? "主文件沒有賣方統編" : r.ruleError})`) : "";
      onApplied({ batchId: r.batchId, message: ruleMsg || undefined });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  async function post(path: string, okMessage: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<{ batchId?: number; assetId?: string }>(path, { method: "POST", body: "{}" });
      onApplied({ batchId: r.batchId ?? null, message: r.assetId ? `${okMessage} ${r.assetId}` : okMessage });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const head = "flex w-full items-center justify-between px-2 py-1.5 text-left hover:bg-muted";
  const opt = "block w-full px-3 py-1 text-left hover:bg-muted disabled:opacity-50";
  const inp = "h-7 w-full border border-input bg-background px-1.5 text-[11px]";
  const toggle = (s: Section) => setSection((cur) => (cur === s ? null : s));
  const anyRule = target.items.some((i) => i.categorySource === "rule");
  const anyAdvance = target.items.some((i) => i.isAdvance);
  const anyExcluded = target.items.some((i) => i.excludeFromReport);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 max-h-[80vh] w-64 overflow-y-auto border border-line bg-background text-xs shadow-lg"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="border-b border-line px-2 py-1.5 text-[11px] text-foreground-3">{single ? `品項「${target.items[0].name}」` : `已選 ${target.items.length} 個品項`}</div>
      {error && <div className="border-b border-destructive-line bg-destructive-bg px-2 py-1 text-destructive">{error}</div>}

      <button type="button" className={head} onClick={() => toggle("category")}>
        費用類別 <span>›</span>
      </button>
      {section === "category" && (
        <div className="pb-1">
          {orderedCats.recent.length > 0 && <div className="px-3 pt-1 text-[10px] text-foreground-3">最近使用</div>}
          {orderedCats.recent.map((c) => (
            <button key={`r-${c.id}`} type="button" disabled={busy} className={opt} onClick={() => apply({ categoryId: c.id }, true)}>
              {c.name}
            </button>
          ))}
          {orderedCats.recent.length > 0 && <div className="px-3 pt-1 text-[10px] text-foreground-3">全部</div>}
          {orderedCats.rest.map((c) => (
            <button key={c.id} type="button" disabled={busy} className={`${opt} ${c.parentId ? "pl-6" : ""}`} onClick={() => apply({ categoryId: c.id }, true)}>
              {c.parentId ? "└ " : ""}
              {c.name}
              {c.accountTitle && <span className="ml-1 text-[10px] text-foreground-3">{c.accountTitle}</span>}
            </button>
          ))}
          <button type="button" disabled={busy} className={`${opt} text-foreground-3`} onClick={() => apply({ categoryId: null })}>
            清除類別
          </button>
          {single && anyRule && (
            <button type="button" disabled={busy} className={`${opt} text-primary`} onClick={() => post(`/api/purchase-items/${ids[0]}/reset-rule`, "已改回(自動規則帶入的類別已清除)")}>
              改回(取消自動規則帶入)
            </button>
          )}
        </div>
      )}

      <button type="button" className={head} onClick={() => toggle("ownership")}>
        歸屬 <span>›</span>
      </button>
      {section === "ownership" && (
        <div className="pb-1">
          <button type="button" disabled={busy} className={opt} onClick={() => apply({ ownership: null }, false)}>
            跟發票{objectOwnership ? `(${OWNERSHIP_LABELS[objectOwnership as OwnershipScope] ?? objectOwnership})` : ""}
          </button>
          {(Object.keys(OWNERSHIP_LABELS) as OwnershipScope[]).map((k) => (
            <button key={k} type="button" disabled={busy} className={opt} onClick={() => apply({ ownership: k }, true)}>
              {OWNERSHIP_LABELS[k]}
            </button>
          ))}
          <div className="px-3 pt-0.5 text-[10px] text-foreground-3">截止日後的發票設成混合歸屬會列入月報表「待確認」。</div>
        </div>
      )}

      <button type="button" className={head} onClick={() => toggle("project")}>
        指定專案 <span>›</span>
      </button>
      {section === "project" && (
        <div className="space-y-1 px-2 pb-2">
          <input autoFocus value={projectQ} onChange={(e) => setProjectQ(e.target.value)} placeholder="搜尋或輸入 AP_YYNNN" className={inp} />
          {projects.map((p) => (
            <button key={p.id} type="button" disabled={busy} className={opt} onClick={() => apply({ projectCode: p.id }, true)}>
              <span className="font-mono">{p.id}</span> {p.name}
            </button>
          ))}
          {/^AP_\d{5}$/.test(projectQ.trim()) && !projects.some((p) => p.id === projectQ.trim()) && (
            <button type="button" disabled={busy} className={opt} onClick={() => apply({ projectCode: projectQ.trim() }, true)}>
              使用 <span className="font-mono">{projectQ.trim()}</span>(專案主檔尚未建立)
            </button>
          )}
          <button type="button" disabled={busy} className={`${opt} text-foreground-3`} onClick={() => apply({ projectCode: null })}>
            不屬於專案
          </button>
        </div>
      )}

      <button type="button" className={head} onClick={() => toggle("advance")}>
        代墊 <span>›</span>
      </button>
      {section === "advance" && (
        <div className="pb-1">
          <div className="px-3 pt-1 text-[10px] text-foreground-3">標記「代墊,待請款」,請款對象:</div>
          {(data?.payees ?? [])
            .filter((p) => p.isActive)
            .map((p) => (
              <button key={p.id} type="button" disabled={busy} className={opt} onClick={() => apply({ isAdvance: true, advancePayee: p.id })}>
                {p.name}
              </button>
            ))}
          {anyAdvance && (
            <>
              <button type="button" disabled={busy} className={opt} onClick={() => apply({ advanceSettled: true })}>
                標為已請回
              </button>
              <button type="button" disabled={busy} className={opt} onClick={() => apply({ advanceSettled: false })}>
                改回未請回
              </button>
              <button type="button" disabled={busy} className={`${opt} text-foreground-3`} onClick={() => apply({ isAdvance: false })}>
                取消代墊
              </button>
            </>
          )}
        </div>
      )}

      <button type="button" className={head} onClick={() => toggle("warranty")}>
        建立保固/資產 <span>›</span>
      </button>
      {section === "warranty" && (
        <div className="space-y-1 px-2 pb-2">
          <label className="block text-[10px] text-foreground-3">
            保固起
            <input type="date" value={warranty.start} onChange={(e) => setWarranty((w) => ({ ...w, start: e.target.value }))} className={inp} />
          </label>
          <label className="block text-[10px] text-foreground-3">
            保固迄(填了會出現在「保固與訂閱」)
            <input type="date" value={warranty.end} onChange={(e) => setWarranty((w) => ({ ...w, end: e.target.value }))} className={inp} />
          </label>
          <button type="button" disabled={busy} className="border border-line px-2 py-1 hover:bg-muted" onClick={() => apply({ warrantyStartDate: warranty.start || null, warrantyEndDate: warranty.end || null })}>
            套用保固
          </button>
          {single && (
            <button type="button" disabled={busy} className="ml-1 border border-line px-2 py-1 hover:bg-muted" onClick={() => post(`/api/purchase-items/${ids[0]}/asset`, "已建立資產")}>
              由此品項建立資產
            </button>
          )}
        </div>
      )}

      {single && (
        <>
          <button type="button" className={head} onClick={() => toggle("rename")}>
            修正品名 <span>›</span>
          </button>
          {section === "rename" && (
            <div className="space-y-1 px-2 pb-2">
              <input autoFocus value={rename} onChange={(e) => setRename(e.target.value)} className={inp} />
              <div className="text-[10px] text-foreground-3">原始辨識品名:{target.items[0].nameOriginal ?? target.items[0].name}(會保留)</div>
              <button type="button" disabled={busy || !rename.trim()} className="border border-line px-2 py-1 hover:bg-muted" onClick={() => apply({ name: rename })}>
                儲存品名
              </button>
            </div>
          )}
        </>
      )}

      <button type="button" className={head} onClick={() => toggle("exclude")}>
        不列帳 <span>›</span>
      </button>
      {section === "exclude" && (
        <div className="space-y-1 px-2 pb-2">
          <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="原因(必填,例:重複單據、已退貨)" className={inp} />
          <button type="button" disabled={busy || !reason.trim()} className="border border-line px-2 py-1 hover:bg-muted" onClick={() => apply({ excludeFromReport: true, excludeReason: reason })}>
            不計入月報表
          </button>
          {anyExcluded && (
            <button type="button" disabled={busy} className="ml-1 border border-line px-2 py-1 hover:bg-muted" onClick={() => apply({ excludeFromReport: false })}>
              恢復列帳
            </button>
          )}
        </div>
      )}

      <div className="border-t border-line px-2 py-1.5">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          記住此分類(之後同賣方統編自動套用)
        </label>
        {remember && <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="品名關鍵字(可空;空白 = 這家店全部品項)" className={`${inp} mt-1`} />}
        {remember && <div className="mt-0.5 text-[10px] text-foreground-3">套用類別、歸屬或專案時一併建立規則;可在管理後台「品項類別 › 自動規則」停用。</div>}
      </div>
      <button
        type="button"
        disabled={busy}
        className="w-full border-t border-line px-2 py-1.5 text-left text-foreground-3 hover:bg-muted"
        onClick={async () => {
          setBusy(true);
          try {
            await apiFetch("/api/purchase-items/undo", { method: "POST", body: "{}" });
            onApplied({ batchId: null, message: "已復原最近一次套用" });
            onClose();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        復原最近一次套用(Undo)
      </button>
    </div>
  );
}
