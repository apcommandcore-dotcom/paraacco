"use client";

// 列表上物件列的品項(2026-09-29,CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md 5.2)——
// 總覽/處理中心/依標題瀏覽共用:依畫面上的物件 id 批次抓品項(GET /api/purchases/items?purchaseIds=,每批 50),
// 展開時在物件列下方縮排列出品項(品名、數量、單價、小計、歸屬、附件數)。
// 2026-10-01(V1.02 7.2):品項子列可按右鍵(或「⋯」)開品項選單,列上顯示類別/專案/代墊/不列帳標籤;
// 套用後發 ITEMS_CHANGED_EVENT,所有 useObjectItems 重新抓。

import { useEffect, useMemo, useState } from "react";
import { TableCell, TableRow } from "@/components/ui/table";
import { apiFetch, OWNERSHIP_LABELS, type OwnershipScope, type PurchaseItemRow } from "@/lib/api";
import { formatCents } from "@/lib/format";
import { ItemContextMenu, ItemMenuButton, ItemTags, useItemMenu, useItemMenuData } from "@/components/item-menu";

export const ITEMS_CHANGED_EVENT = "paraacco:object-items-changed";

const nt = (cents: number) => formatCents(cents);

export function useObjectItems(purchaseIds: Array<string | null | undefined>): Map<string, PurchaseItemRow[]> {
  const ids = useMemo(() => [...new Set(purchaseIds.filter((x): x is string => !!x))].sort(), [purchaseIds]);
  const key = ids.join(",");
  const [items, setItems] = useState<Map<string, PurchaseItemRow[]>>(new Map());
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(ITEMS_CHANGED_EVENT, bump);
    return () => window.removeEventListener(ITEMS_CHANGED_EVENT, bump);
  }, []);
  useEffect(() => {
    if (!ids.length) {
      setItems(new Map());
      return;
    }
    let cancelled = false;
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
    Promise.all(chunks.map((c) => apiFetch<{ items: PurchaseItemRow[] }>(`/api/purchases/items?purchaseIds=${c.join(",")}`)))
      .then((res) => {
        if (cancelled) return;
        const m = new Map<string, PurchaseItemRow[]>();
        for (const it of res.flatMap((r) => r.items)) m.set(it.purchaseId, [...(m.get(it.purchaseId) ?? []), it]);
        setItems(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);
  return items;
}

export type ItemColumn = "blank" | "name" | "amount" | "ownership";

/** 物件列展開後的品項子列。layout 依該列表的欄位順序排,例:["blank", "name", "blank", "blank", "amount", "ownership", "blank"]。 */
export function ItemSubRows({ items, objectOwnership, layout }: { items: PurchaseItemRow[]; objectOwnership: string; layout: ItemColumn[] }) {
  const menu = useItemMenu();
  const menuData = useItemMenuData();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <>
      {menu.target && (
        <ItemContextMenu
          target={menu.target}
          data={menuData.data}
          objectOwnership={objectOwnership}
          onClose={menu.close}
          onApplied={(r) => {
            setMessage(r.batchId ? `已套用(批次 #${r.batchId});要復原請再按右鍵 › 復原最近一次套用${r.message ?? ""}` : (r.message ?? null));
            menuData.reload();
            window.dispatchEvent(new Event(ITEMS_CHANGED_EVENT));
          }}
        />
      )}
      {message && (
        <TableRow className="bg-muted text-[11px]">
          <TableCell colSpan={layout.length} className="pl-5 text-foreground-3">
            {message}
            <button type="button" className="ml-2 hover:text-foreground" onClick={() => setMessage(null)}>
              ×
            </button>
          </TableCell>
        </TableRow>
      )}
      {items.map((it) => (
        <TableRow key={it.id} className={`bg-muted text-xs ${it.excludeFromReport ? "text-foreground-3 line-through" : ""}`} onContextMenu={(e) => menu.open([it], e)}>
          {layout.map((col, i) => {
            if (col === "name")
              return (
                <TableCell key={i} className="pl-5 text-foreground-2">
                  └ {it.name}
                  <span className="ml-1.5 font-mono text-[10px] text-foreground-3">
                    ×{it.quantity}
                    {it.unitPriceCents != null ? ` @${nt(it.unitPriceCents)}` : ""}
                  </span>
                  <ItemTags item={it} data={menuData.data} />
                  <ItemMenuButton onOpen={(e) => menu.open([it], e)} />
                </TableCell>
              );
            if (col === "amount")
              return (
                <TableCell key={i} className="whitespace-nowrap font-mono text-foreground-2">
                  {nt(it.amountCents)}
                </TableCell>
              );
            if (col === "ownership")
              return (
                <TableCell key={i} className={`whitespace-nowrap ${it.ownership ? "font-semibold" : "text-foreground-3"}`}>
                  {OWNERSHIP_LABELS[(it.ownership ?? objectOwnership) as OwnershipScope] ?? it.ownership ?? objectOwnership}
                </TableCell>
              );
            return <TableCell key={i} />;
          })}
        </TableRow>
      ))}
    </>
  );
}
