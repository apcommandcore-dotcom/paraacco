// 保固/訂閱到期狀態 —— 2026-09-07 補完設計落差任務書任務 3。狀態不落地存欄位,用
// end_date 跟 reminder_days_before 即時算,API 路由跟排程通知邏輯共用同一份判斷,避免
// 兩邊各自寫一次條件式導致邊界不一致(尤其是「即將到期」的門檻)。

export type WarrantyStatus = "active" | "due_soon" | "expired";

export interface WarrantyStatusInput {
  endDate: string; // YYYY-MM-DD
  reminderDaysBefore: number;
}

/** now 預設用呼叫端的當下時間,測試時可以傳入固定值做確定性驗證。 */
export function computeWarrantyStatus({ endDate, reminderDaysBefore }: WarrantyStatusInput, now: Date = new Date()): WarrantyStatus {
  const daysUntilDue = daysUntil(endDate, now);
  if (daysUntilDue < 0) return "expired";
  if (daysUntilDue <= reminderDaysBefore) return "due_soon";
  return "active";
}

/** 回傳距離到期日還有幾天(可為負數,代表已過期幾天)。以「日曆天」比較,不管時分秒。 */
export function daysUntil(endDate: string, now: Date = new Date()): number {
  const end = new Date(`${endDate}T00:00:00Z`);
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((end.getTime() - today.getTime()) / msPerDay);
}

// ---------------------------------------------------------------------------
// 2026-09-26:擴充成「保固、訂閱與定期繳費」(migration 0008)。列舉值跟 DB CHECK 約束一致,
// API 寫入前先用這裡驗證,不要讓不合法的值一路打到 D1 才被 CHECK 擋成 500。
// ---------------------------------------------------------------------------

export const WARRANTY_TYPES = ["warranty", "subscription", "recurring_bill"] as const;
export type WarrantyType = (typeof WARRANTY_TYPES)[number];

export const RENEWAL_CYCLES = ["one_time", "monthly", "bimonthly", "quarterly", "semiannual", "yearly"] as const;
export type RenewalCycle = (typeof RENEWAL_CYCLES)[number];

export const PAYMENT_METHODS = ["auto_debit", "credit_card", "manual"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** 細分類。DB 層不加 CHECK(之後要加新分類不需要 migration 重建表),只在 API 層驗證。 */
export const WARRANTY_CATEGORIES = [
  "water", // 水費
  "electricity", // 電費
  "gas", // 瓦斯
  "internet", // 網路
  "telecom", // 電信/手機
  "labor_insurance", // 勞保
  "health_insurance", // 健保
  "pension", // 勞退
  "tax", // 稅金(營業稅、房屋稅、地價稅、牌照稅、所得稅等)
  "insurance", // 商業保險(車險、產險、壽險)
  "rent", // 租金(辦公室、車位)
  "software", // 軟體/線上服務訂閱
  "membership", // 會費(公會等)
  "device", // 硬體保固
  "other",
] as const;
export type WarrantyCategory = (typeof WARRANTY_CATEGORIES)[number];

const CYCLE_MONTHS: Record<Exclude<RenewalCycle, "one_time">, number> = {
  monthly: 1,
  bimonthly: 2,
  quarterly: 3,
  semiannual: 6,
  yearly: 12,
};

/**
 * 定期繳費「繳完、排下一期」:把到期日往後推一個週期。月底日遇到較短的月份會夾到該月最後一天
 * (例如 01-31 + 1 個月 = 02-28/29),不會溢位到下個月。one_time 回傳 null(沒有下一期)。
 */
export function advanceDueDate(endDate: string, cycle: RenewalCycle): string | null {
  if (cycle === "one_time") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endDate);
  if (!m) throw new Error(`invalid date: ${endDate}`);
  const year = Number(m[1]);
  const month0 = Number(m[2]) - 1 + CYCLE_MONTHS[cycle];
  const day = Number(m[3]);
  const y = year + Math.floor(month0 / 12);
  const mo = month0 % 12;
  const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const d = Math.min(day, lastDay);
  return `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
