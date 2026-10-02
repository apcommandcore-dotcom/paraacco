// 金額與擷取欄位的顯示(2026-10-01,CODE_TASK_purchase-object-merge-docs_20260929_V1.02.md 7.1)。
// 全站凡是 *_cents / amountCents 的值一律經 formatCents 顯示(資料庫存「分」,畫面顯示 NT$ 元),
// 不要再各頁自己寫 cents / 100。擷取欄位的顯示名稱統一用中文會計用語(FIELD_LABELS),
// 品項明細(line_items)以表格顯示,不顯示原始 JSON。

/** 以「分」為單位的金額 → `NT$1,234`(有角分才顯示小數;負數用「−」)。null/undefined → 「—」。 */
export function formatCents(
  cents: number | null | undefined,
  opts: { currency?: string | null; round?: boolean } = {},
): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  const cur = opts.currency && opts.currency !== "TWD" ? `${opts.currency} ` : "NT$";
  const v = Math.abs(cents) / 100;
  const s = (opts.round ? Math.round(v) : v).toLocaleString("zh-TW", { maximumFractionDigits: 2 });
  return `${cents < 0 ? "−" : ""}${cur}${s}`;
}

/** 表單編輯用:分 → 元的字串(不加千分位/幣別)。 */
export function centsToInput(cents: number | null | undefined): string {
  return cents == null ? "" : String(cents / 100);
}

/** CSV 匯出用:分 → 元的數字。 */
export function centsToNumber(cents: number): number {
  return cents / 100;
}

/** 擷取欄位 fieldKey → 顯示名稱(收據/發票一律中文會計用語)。沒列到的沿用 API 給的 label。 */
export const FIELD_LABELS: Record<string, string> = {
  vendorNameRaw: "賣方名稱",
  vendorTaxId: "賣方統編",
  vendorTaxIdQr: "賣方統編(QR)",
  vendorTaxIdPrinted: "賣方統編(印字)",
  vendorTaxIdSource: "賣方統編來源",
  buyerTaxId: "買方統編",
  invoiceNo: "發票號碼",
  invoicePeriod: "發票期別",
  invoiceDate: "交易日期",
  docDate: "單據日期",
  line_items: "品項",
  amountCents: "含稅總計",
  net_amount: "銷售額(未稅)",
  tax_amount: "營業稅額",
  taxable_amount: "應稅銷售額",
  tax_free_amount: "免稅銷售額",
  payment_method: "付款方式",
  currency: "幣別",
  serialNo: "隨機碼/序號",
  brand: "品牌(與賣方不同時)",
  model: "型號",
  machine_no: "電子發票機台號",
  orderNo: "訂單號碼",
  docTypeCode: "文件類型",
  finance_doc_type: "單據類型",
  document_role: "單據角色",
  billing_month: "帳單月份",
  billing_month_2: "帳單月份 2",
  billing_month_3: "帳單月份 3",
  billing_month_4: "帳單月份 4",
  recurring_series_id: "定期繳費項目",
  accountNumber: "用戶號碼",
  ownership_scope: "歸屬範圍",
  ingest_channel: "進件管道",
  _ocr_status: "OCR 狀態",
};

/** 值以「分」儲存的擷取欄位。 */
export const MONEY_FIELD_KEYS = new Set(["amountCents", "net_amount", "tax_amount", "taxable_amount", "tax_free_amount"]);

export function fieldLabel(fieldKey: string, fallback?: string | null): string {
  return FIELD_LABELS[fieldKey] ?? fallback ?? fieldKey;
}

export interface LineItemRow {
  name: string;
  qty: number | null;
  unitPrice: number | null; // 元
  amount: number | null; // 元
}

/** line_items 的 JSON(擷取時以「元」記)→ 表格列;不是合法 JSON 陣列回 null(畫面改顯示原字串)。 */
export function parseLineItems(value: string | null | undefined): LineItemRow[] | null {
  if (!value) return null;
  try {
    const arr = JSON.parse(value) as unknown;
    if (!Array.isArray(arr)) return null;
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x)) ? Number(x) : null);
    return arr
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => ({
        name: String(x.name ?? x.description ?? "—"),
        qty: num(x.qty ?? x.quantity),
        unitPrice: num(x.unitPrice ?? x.unit_price),
        amount: num(x.amount ?? x.subtotal),
      }));
  } catch {
    return null;
  }
}
