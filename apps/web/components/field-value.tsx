"use client";

// 擷取欄位的值(2026-10-01,V1.02 7.1):金額欄位經 formatCents、品項明細以表格顯示(不出現原始 JSON)。

import { formatCents, MONEY_FIELD_KEYS, parseLineItems } from "@/lib/format";

export function FieldValue({ fieldKey, value, currency }: { fieldKey: string; value: string | null; currency?: string | null }) {
  if (value == null || value === "") return <>—</>;
  if (MONEY_FIELD_KEYS.has(fieldKey) && /^-?\d+$/.test(value.trim())) return <>{formatCents(Number(value), { currency })}</>;
  if (fieldKey === "line_items") {
    const rows = parseLineItems(value);
    if (rows) return <LineItemsTable rows={rows} currency={currency} />;
  }
  return <>{value}</>;
}

export function LineItemsTable({ rows, currency }: { rows: NonNullable<ReturnType<typeof parseLineItems>>; currency?: string | null }) {
  if (!rows.length) return <span className="text-xs text-muted-foreground">沒有品項</span>;
  // line_items 擷取時以「元」記 → ×100 交給 formatCents,和全站同一個格式
  const money = (yuan: number | null) => (yuan == null ? "—" : formatCents(Math.round(yuan * 100), { currency }));
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted-foreground">
          <th className="py-1 pr-2 text-left font-normal">品名</th>
          <th className="py-1 pr-2 text-right font-normal">數量</th>
          <th className="py-1 pr-2 text-right font-normal">單價</th>
          <th className="py-1 text-right font-normal">小計</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-border">
            <td className="py-1 pr-2">{r.name}</td>
            <td className="py-1 pr-2 text-right font-mono">{r.qty ?? "—"}</td>
            <td className="py-1 pr-2 text-right font-mono">{money(r.unitPrice)}</td>
            <td className="py-1 text-right font-mono">{money(r.amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
