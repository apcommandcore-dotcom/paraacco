// 「對象」顯示(2026-09-29,CODE_TASK_vendor-name-from-taxid_20260929.md R-V1)——主檔名稱優先;
// 未建檔時顯示 OCR 店名(灰字 + 「未建檔」),OCR 店名只供參考。
import { displayVendor } from "@/lib/api";

export function VendorName({ doc, className = "" }: { doc: { vendorName?: string | null; vendorNameRaw?: string | null }; className?: string }) {
  const v = displayVendor(doc);
  if (v.registered) return <span className={className}>{v.name}</span>;
  return (
    <span className={`text-foreground-3 ${className}`} title="供應商未建檔,顯示 OCR 讀到的店名(僅供參考)">
      {v.name}
      {v.name !== "—" && <span className="ml-1 text-[10px] text-warning">未建檔</span>}
    </span>
  );
}
