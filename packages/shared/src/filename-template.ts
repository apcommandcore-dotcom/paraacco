// 檔名模板 —— 對應規格文件 2.5 節,管理後台「分類樹與檔名模板」頁籤明文寫出的規則:
// {PurchaseID}_{文件代碼}_{日期}_{供應商}_{識別碼}_{金額}.pdf

export type DocTypeCode = "INV" | "WAR" | "RET" | "DEL" | "ORD" | "SUB" | "MAN";

export const DOC_TYPE_LABELS: Record<DocTypeCode, string> = {
  INV: "發票",
  WAR: "保證書",
  RET: "收據",
  DEL: "出貨單",
  ORD: "訂單",
  SUB: "訂閱／帳單",
  MAN: "說明書",
};

export interface CanonicalFileNameInput {
  purchaseId: string;
  docTypeCode: DocTypeCode;
  /** ISO 日期字串 YYYY-MM-DD */
  date: string;
  vendorName: string;
  /** 發票號／訂單號／序號等識別碼,無則傳 undefined,會顯示為 — */
  identifier?: string;
  /** 無則傳 undefined,會顯示為 — */
  amount?: string;
  ext?: string;
}

export function canonicalFileName(input: CanonicalFileNameInput): string {
  const date = input.date.replace(/-/g, "");
  const vendor = input.vendorName.replace(/[\\/:*?"<>|\s]+/g, "");
  const identifier = input.identifier || "—";
  const amount = input.amount || "—";
  const ext = input.ext || "pdf";
  return `${input.purchaseId}_${input.docTypeCode}_${date}_${vendor}_${identifier}_${amount}.${ext}`;
}
