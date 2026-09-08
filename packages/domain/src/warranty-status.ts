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
