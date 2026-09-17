import * as React from "react";
import { cn } from "@/lib/utils";

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("border-b border-line", className)} {...props} />;
}

export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...props} />;
}

export function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("border-b border-line-2 last:border-0 hover:bg-accent", className)} {...props} />;
}

export function TableHead({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  // whitespace-nowrap 是這裡新加的(2026-09-17)——欄位數較多的表格(資產/採購案列表)
  // 在較窄的視窗寬度下,標題文字(例如「購買日期」)沒有 nowrap 會逐字換行,對照設計稿
  // 表格標題一律單行呈現,不應該有這種情形。
  return (
    <th
      className={cn("whitespace-nowrap px-3 py-2 text-left font-mono text-xs uppercase tracking-widest text-foreground-3", className)}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-3 py-2 align-top", className)} {...props} />;
}
