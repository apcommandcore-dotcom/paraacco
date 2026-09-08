// 「本週」邊界(週一到週日)—— 2026-09-07 補完設計落差任務書任務 4(總覽待處理事項)、
// 任務 5(通知排程)共用同一份「本週」定義,避免 dashboard widget 跟排程通知各自認定
// 週一的定義不一致。全部用 UTC 日曆天比較,不處理時區精確到小時(這個系統目前也沒有存
// 使用者時區),對記帳/覆核提醒這種「哪一天」等級的用途足夠。

/** 傳入時間所在週的週一 00:00(UTC 日曆天),ISO 星期一 = 1、星期日 = 7。 */
export function startOfWeek(now: Date = new Date()): Date {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const isoDay = today.getUTCDay() === 0 ? 7 : today.getUTCDay(); // 把 JS 的 0(週日)轉成 ISO 的 7
  today.setUTCDate(today.getUTCDate() - (isoDay - 1));
  return today;
}

/** 傳入時間所在週的週日 00:00(UTC 日曆天)。 */
export function endOfWeek(now: Date = new Date()): Date {
  const monday = startOfWeek(now);
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return sunday;
}

/** 距離本週日還有幾天(0 = 今天就是週日,負數 = 已經過了本週日)。 */
export function daysUntilEndOfWeek(now: Date = new Date()): number {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const sunday = endOfWeek(now);
  return Math.round((sunday.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}

/** dateISO(YYYY-MM-DD)是否落在 now 所在的這一週(週一~週日)內。 */
export function isThisWeek(dateISO: string, now: Date = new Date()): boolean {
  const d = new Date(`${dateISO}T00:00:00Z`);
  return d >= startOfWeek(now) && d <= endOfWeek(now);
}

/** dateISO 是否早於本週週一(代表是上一週或更早遺留下來的)。 */
export function isBeforeThisWeek(dateISO: string, now: Date = new Date()): boolean {
  const d = new Date(`${dateISO}T00:00:00Z`);
  return d < startOfWeek(now);
}
