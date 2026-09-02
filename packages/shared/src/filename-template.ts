// 檔名模板 —— 對應規格文件 2.5 節,管理後台「分類樹與檔名模板」頁籤明文寫出的規則:
// {PurchaseID}_{文件代碼}_{日期}_{供應商}_{識別碼}_{金額}.pdf
//
// v2 修正(規格文件缺口清單第 7 點,我方原本自己標記的未解問題):v1 的 SUB 同時代表
// 「訂閱」跟「帳單」兩種語意不同的文件,容易混淆 —— 拆成 SUB(訂閱,例如雲端服務訂閱合約/
// 續訂通知)與 BIL(帳單/對帳單,例如信用卡帳單、水電帳單這類「本身不是採購憑證,但要用來
// 核對代墊/報帳金額」的文件類型)。

export type DocTypeCode = "INV" | "WAR" | "RET" | "DEL" | "ORD" | "SUB" | "BIL" | "MAN";

export const DOC_TYPE_LABELS: Record<DocTypeCode, string> = {
  INV: "發票",
  WAR: "保證書",
  RET: "收據",
  DEL: "出貨單",
  ORD: "訂單",
  SUB: "訂閱",
  BIL: "帳單",
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
