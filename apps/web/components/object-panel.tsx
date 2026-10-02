"use client";

// 物件詳情(2026-09-29,CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md 2.2、2.3、5.1–5.3)——
// 主文件 + 附件(依角色分組,可改角色/改掛品項/設為主文件/移出)、品項(可改歸屬/保固/序號、拆分、刪除、新增)、
// 開箱影片/照片(只記 NAS 路徑,原檔不上傳;NAS 改名由 archive.py --source attachments 出計畫確認後才執行)。
// 影片播放:原檔只在 NAS,瀏覽器不能直接播 smb:// 路徑,這裡顯示完整 NAS 路徑讓使用者在 Finder 開啟(評估見報告)。

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCents } from "@/lib/format";
import { ItemContextMenu, ItemMenuButton, ItemTags, UndoBar, useItemMenu, useItemMenuData } from "@/components/item-menu";
import {
  apiFetch,
  ATTACHMENT_ROLE_LABELS,
  DOC_KIND_LABELS,
  OWNERSHIP_LABELS,
  type ObjectDetail,
  type OwnershipScope,
  type PurchaseRow,
} from "@/lib/api";

const nt = (cents: number | null | undefined) => formatCents(cents);
const LOCAL_ROOT = "smb://192.168.20.91/ATLPAR_Bookkeeper";

export function ObjectPanel({ purchaseId, onChanged }: { purchaseId: string; onChanged?: () => void }) {
  const [obj, setObj] = useState<ObjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newDoc, setNewDoc] = useState({ documentId: "", role: "" });
  const [newItem, setNewItem] = useState({ name: "", amount: "" });
  const [newAtt, setNewAtt] = useState({ kind: "video", localPath: "", itemId: "" });
  // V1.02 7.2 品項右鍵選單:勾選多個品項後右鍵一起套用
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applied, setApplied] = useState<{ batchId: number | null; message?: string } | null>(null);
  const menu = useItemMenu();
  const menuData = useItemMenuData();

  const load = useCallback(() => {
    apiFetch<{ purchase: PurchaseRow; object: ObjectDetail | null }>(`/api/purchases/${purchaseId}`)
      .then((d) => setObj(d.object))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [purchaseId]);
  useEffect(load, [load]);

  async function act(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(path, { method: "POST", body: JSON.stringify(body) });
      load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!obj) return error ? <div className="text-xs text-destructive">{error}</div> : <div className="text-xs text-muted-foreground">載入物件…</div>;

  const attachments = obj.documents.filter((d) => d.relationKind !== "primary");
  const objectOwnership = obj.primary?.ownership ?? obj.purchase.ownership;
  const sel = "h-7 border border-input bg-background px-1 text-[11px]";

  return (
    <div className="space-y-4 text-xs">
      {error && <div className="border border-destructive-line bg-destructive-bg p-2 text-destructive">{error}</div>}
      <div className="flex flex-wrap gap-1.5">
        {obj.flags.itemAmountMismatch && <Badge variant="warning">品項金額不符(品項加總 ≠ 發票總額,送覆核)</Badge>}
        {obj.flags.mixedOwnership && <Badge variant={obj.flags.mixedOwnershipWarning ? "destructive" : "info"}>混合歸屬</Badge>}
        {obj.flags.ownershipConflicts.length > 0 && <Badge variant="warning">附件歸屬與主文件不同:{obj.flags.ownershipConflicts.join("、")}(以主文件為準)</Badge>}
      </div>
      {obj.flags.mixedOwnershipWarning && (
        <div className="flex items-center gap-2 border border-destructive-line bg-destructive-bg p-2 text-destructive">
          <AlertTriangle size={13} />
          開立日在 {obj.flags.cutoff} 之後的發票設成混合歸屬:專案/公司使用應單獨開發票。仍可儲存,已列入月報表「待確認」。
        </div>
      )}

      <section>
        <h4 className="mb-1 font-semibold">主文件</h4>
        {obj.primary ? (
          <div className="border border-line p-2">
            <Link href={`/documents?view=document&id=${obj.primary.documentId}`} className="font-mono text-primary hover:underline">
              {obj.primary.documentId}
            </Link>{" "}
            <Badge variant="outline">{DOC_KIND_LABELS[obj.primary.kind] ?? obj.primary.kind}</Badge> {obj.primary.date} · {obj.primary.vendorName ?? obj.primary.vendorNameRaw ?? "—"} ·{" "}
            {obj.primary.invoiceNo ?? "無發票號"} · <span className="font-mono">{nt(obj.primary.amountCents)}</span> ·{" "}
            {OWNERSHIP_LABELS[objectOwnership as OwnershipScope] ?? objectOwnership}
            {obj.primary.kind !== "invoice" && <div className="mt-1 text-foreground-3">目前沒有發票,由{DOC_KIND_LABELS[obj.primary.kind]}暫代主文件;發票加入後會自動接手。</div>}
          </div>
        ) : (
          <div className="text-foreground-3">沒有主文件</div>
        )}
      </section>

      <section>
        <h4 className="mb-1 font-semibold">附件({attachments.length})</h4>
        {attachments.length === 0 && <div className="text-foreground-3">沒有附件。</div>}
        {attachments.map((d) => (
          <div key={d.documentId} className="mb-1 flex flex-wrap items-center gap-1.5 border border-line-2 p-1.5">
            <Link href={`/documents?view=document&id=${d.documentId}`} className="font-mono text-primary hover:underline">
              {d.documentId}
            </Link>
            <span className="text-foreground-3">
              {d.date} {nt(d.amountCents)} {OWNERSHIP_LABELS[d.ownership as OwnershipScope] ?? ""}
            </span>
            <select value={d.attachmentRole ?? "OTHER"} disabled={busy} onChange={(e) => act(`/api/purchases/${purchaseId}/documents`, { documentId: d.documentId, role: e.target.value })} className={sel}>
              {Object.entries(ATTACHMENT_ROLE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <select
              value={d.purchaseItemId ?? ""}
              disabled={busy}
              onChange={(e) => act(`/api/purchases/${purchaseId}/documents`, { documentId: d.documentId, role: d.attachmentRole, itemId: e.target.value || null })}
              className={`${sel} max-w-[140px]`}
              title="掛在物件層或某個品項"
            >
              <option value="">物件層</option>
              {obj.items.map((it) => (
                <option key={it.id} value={it.id}>
                  品項 {it.lineNo}:{it.name}
                </option>
              ))}
            </select>
            <button type="button" disabled={busy} className="text-primary hover:underline" onClick={() => act(`/api/purchases/${purchaseId}/documents`, { documentId: d.documentId, role: "primary" })}>
              設為主文件
            </button>
            <button
              type="button"
              disabled={busy}
              className="text-destructive hover:underline"
              onClick={() => confirm(`把 ${d.documentId} 移出物件?它會恢復成獨立文件。`) && act(`/api/purchases/${purchaseId}/documents/${d.documentId}/remove`, {})}
            >
              移出
            </button>
          </div>
        ))}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Input value={newDoc.documentId} onChange={(e) => setNewDoc((f) => ({ ...f, documentId: e.target.value.trim() }))} placeholder="DOC-2026-000123" className="h-7 w-40 font-mono text-[11px]" />
          <select value={newDoc.role} onChange={(e) => setNewDoc((f) => ({ ...f, role: e.target.value }))} className={sel}>
            <option value="">自動(發票接手主文件)</option>
            <option value="primary">主文件</option>
            {Object.entries(ATTACHMENT_ROLE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !/^DOC-\d{4}-\d{6}$/.test(newDoc.documentId)}
            onClick={() => {
              act(`/api/purchases/${purchaseId}/documents`, { documentId: newDoc.documentId, role: newDoc.role || null });
              setNewDoc({ documentId: "", role: "" });
            }}
          >
            加入文件
          </Button>
        </div>
      </section>

      <section>
        <h4 className="mb-1 font-semibold">
          品項({obj.items.length})<span className="ml-2 font-normal text-foreground-3">歸屬預設跟發票,可逐項改;金額加總仍以發票總額為準。按右鍵(或「⋯」)設類別/專案/代墊…,可先勾選多個一起套用</span>
        </h4>
        {applied && (
          <div className="mb-1">
            {applied.batchId ? (
              <UndoBar
                batchId={applied.batchId}
                onUndone={() => {
                  setApplied(null);
                  load();
                  onChanged?.();
                }}
                onDismiss={() => setApplied(null)}
              />
            ) : (
              <div className="border border-line bg-muted px-2 py-1 text-[11px]">{applied.message}</div>
            )}
            {applied.batchId && applied.message && <div className="text-[11px] text-foreground-3">{applied.message.replace(/^,/, "")}</div>}
          </div>
        )}
        {menu.target && (
          <ItemContextMenu
            target={menu.target}
            data={menuData.data}
            objectOwnership={objectOwnership}
            onClose={menu.close}
            onApplied={(r) => {
              setApplied(r);
              setSelected(new Set());
              load();
              menuData.reload();
              onChanged?.();
            }}
          />
        )}
        {obj.items.length > 0 && (
          <table className="w-full">
            <thead>
              <tr className="border-b border-line text-left text-foreground-3">
                <th className="w-5 py-1 font-normal">
                  <input
                    type="checkbox"
                    aria-label="全選品項"
                    checked={selected.size > 0 && selected.size === obj.items.length}
                    onChange={(e) => setSelected(e.target.checked ? new Set(obj.items.map((i) => i.id)) : new Set())}
                  />
                </th>
                <th className="py-1 font-normal">#</th>
                <th className="py-1 font-normal">品名</th>
                <th className="py-1 text-right font-normal">數量</th>
                <th className="py-1 text-right font-normal">小計</th>
                <th className="py-1 font-normal">歸屬</th>
                <th className="py-1 font-normal">序號</th>
                <th className="py-1 font-normal">保固迄</th>
                <th className="py-1 font-normal">附件</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {obj.items.map((it) => (
                <tr
                  key={it.id}
                  className={`border-b border-line-2 last:border-0 ${selected.has(it.id) ? "bg-muted" : ""} ${it.excludeFromReport ? "text-foreground-3 line-through decoration-foreground-3/50" : ""}`}
                  onContextMenu={(e) => menu.open(selected.has(it.id) ? obj.items.filter((x) => selected.has(x.id)) : [it], e)}
                >
                  <td className="py-1">
                    <input
                      type="checkbox"
                      aria-label={`選取 ${it.name}`}
                      checked={selected.has(it.id)}
                      onChange={(e) =>
                        setSelected((cur) => {
                          const next = new Set(cur);
                          if (e.target.checked) next.add(it.id);
                          else next.delete(it.id);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td className="py-1 font-mono text-foreground-3">{it.lineNo}</td>
                  <td className="max-w-[200px] py-1">
                    {it.name}
                    {it.source === "split" && <span className="ml-1 text-[10px] text-foreground-3">(拆分)</span>}
                    <ItemTags item={it} data={menuData.data} />
                  </td>
                  <td className="py-1 text-right font-mono">{it.quantity}</td>
                  <td className={`py-1 text-right font-mono ${it.amountCents < 0 ? "text-destructive" : ""}`}>{nt(it.amountCents)}</td>
                  <td className="py-1">
                    <select
                      value={it.ownership ?? ""}
                      disabled={busy}
                      onChange={(e) => act(`/api/purchase-items/${it.id}`, { ownership: e.target.value || null })}
                      className={`${sel} ${it.ownership ? "font-semibold" : ""}`}
                    >
                      <option value="">跟發票({OWNERSHIP_LABELS[objectOwnership as OwnershipScope] ?? objectOwnership})</option>
                      {(Object.keys(OWNERSHIP_LABELS) as OwnershipScope[]).map((k) => (
                        <option key={k} value={k}>
                          {OWNERSHIP_LABELS[k]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1">
                    <input
                      defaultValue={it.serialNo ?? ""}
                      disabled={busy}
                      onBlur={(e) => e.target.value !== (it.serialNo ?? "") && act(`/api/purchase-items/${it.id}`, { serialNo: e.target.value || null })}
                      className="h-7 w-24 border border-input bg-background px-1 font-mono text-[11px]"
                    />
                  </td>
                  <td className="py-1">
                    <input
                      type="date"
                      defaultValue={it.warrantyEndDate ?? ""}
                      disabled={busy}
                      onBlur={(e) => e.target.value !== (it.warrantyEndDate ?? "") && act(`/api/purchase-items/${it.id}`, { warrantyEndDate: e.target.value || null })}
                      className="h-7 border border-input bg-background px-1 text-[11px]"
                      title="保固迄日(填了就會出現在「保固與訂閱」頁)"
                    />
                  </td>
                  <td className="py-1 text-foreground-3">{it.documentIds.length + it.attachmentIds.length || ""}</td>
                  <td className="whitespace-nowrap py-1">
                    {it.quantity > 1 && Number.isInteger(it.quantity) && (
                      <button
                        type="button"
                        disabled={busy}
                        className="mr-2 text-primary hover:underline"
                        onClick={() => act(`/api/purchase-items/${it.id}/split`, { quantities: Array.from({ length: it.quantity }, () => 1) })}
                        title={`拆成 ${it.quantity} 個數量 1 的品項(各掛各的序號與保固)`}
                      >
                        拆分
                      </button>
                    )}
                    <button type="button" disabled={busy} className="text-destructive hover:underline" onClick={() => confirm(`刪除品項「${it.name}」?`) && act(`/api/purchase-items/${it.id}/delete`, {})}>
                      刪除
                    </button>
                    <ItemMenuButton onOpen={(e) => menu.open(selected.has(it.id) ? obj.items.filter((x) => selected.has(x.id)) : [it], e)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Input value={newItem.name} onChange={(e) => setNewItem((f) => ({ ...f, name: e.target.value }))} placeholder="品名" className="h-7 w-40 text-[11px]" />
          <Input value={newItem.amount} onChange={(e) => setNewItem((f) => ({ ...f, amount: e.target.value }))} placeholder="小計(元,折扣填負數)" className="h-7 w-36 text-[11px]" inputMode="decimal" />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !newItem.name.trim() || !/^-?\d+(\.\d{1,2})?$/.test(newItem.amount.trim())}
            onClick={() => {
              act(`/api/purchases/${purchaseId}/items`, { name: newItem.name.trim(), amountCents: Math.round(Number(newItem.amount) * 100) });
              setNewItem({ name: "", amount: "" });
            }}
          >
            新增品項
          </Button>
        </div>
      </section>

      <section>
        <h4 className="mb-1 font-semibold">開箱影片/照片({obj.attachments.length})</h4>
        <p className="mb-1 text-foreground-3">原檔只留 NAS(不上傳);NAS 上改名成「主文件檔名_附件_影片_01」由 archive.py 出計畫,確認後才搬。瀏覽器不能直接播放 NAS 檔,請複製路徑在 Finder 開啟。</p>
        {obj.attachments.map((a) => (
          <div key={a.id} className="mb-1 flex flex-wrap items-center gap-1.5 border border-line-2 p-1.5">
            <Badge variant="outline">{a.kind === "video" ? "影片" : a.kind === "photo" ? "照片" : "其他"}</Badge>
            <span className="break-all font-mono text-[10px]" title="NAS 位置">
              {LOCAL_ROOT}/{a.localPath}
            </span>
            <button type="button" className="text-primary hover:underline" onClick={() => navigator.clipboard?.writeText(`${LOCAL_ROOT}/${a.localPath}`)}>
              複製路徑
            </button>
            <select
              value={a.purchaseItemId ?? ""}
              disabled={busy}
              onChange={(e) => act(`/api/purchase-items/attachments/${a.id}`, { itemId: e.target.value || null })}
              className={`${sel} max-w-[140px]`}
            >
              <option value="">物件層</option>
              {obj.items.map((it) => (
                <option key={it.id} value={it.id}>
                  品項 {it.lineNo}:{it.name}
                </option>
              ))}
            </select>
            <button type="button" disabled={busy} className="text-destructive hover:underline" onClick={() => confirm("移除這筆附件紀錄?NAS 原檔不會動。") && act(`/api/purchase-items/attachments/${a.id}/delete`, {})}>
              移除
            </button>
          </div>
        ))}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <select value={newAtt.kind} onChange={(e) => setNewAtt((f) => ({ ...f, kind: e.target.value }))} className={sel}>
            <option value="video">影片</option>
            <option value="photo">照片</option>
            <option value="other">其他</option>
          </select>
          <Input
            value={newAtt.localPath}
            onChange={(e) => setNewAtt((f) => ({ ...f, localPath: e.target.value.trim() }))}
            placeholder="NAS 路徑,例:Paraacco_公司財務系統/01_SHR_購物開箱存檔影片/IMG_6815.MOV"
            className="h-7 min-w-[260px] flex-1 font-mono text-[11px]"
          />
          <select value={newAtt.itemId} onChange={(e) => setNewAtt((f) => ({ ...f, itemId: e.target.value }))} className={`${sel} max-w-[140px]`}>
            <option value="">物件層</option>
            {obj.items.map((it) => (
              <option key={it.id} value={it.id}>
                品項 {it.lineNo}:{it.name}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !newAtt.localPath}
            onClick={() => {
              act(`/api/purchases/${purchaseId}/attachments`, {
                kind: newAtt.kind,
                localPath: newAtt.localPath.replace(/^smb:\/\/[^/]+\/[^/]+\//, ""),
                itemId: newAtt.itemId || null,
              });
              setNewAtt({ kind: "video", localPath: "", itemId: "" });
            }}
          >
            加入
          </Button>
        </div>
      </section>
    </div>
  );
}
