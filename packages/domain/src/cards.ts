// 信用卡分頁(2026-11-28,SPEC_cards-page_20261128.md)——純函式,API(routes/cards.ts)與 web 共用。
// 卡片 = recurring_series(category='statement'),card_kind 區分信用卡與銀行帳戶(銀行帳戶不追蹤)。
// 分期只看現金流,不計入月報表:支出已在發票月份計入,分期只是之後幾個月怎麼付錢。

export const CARD_CATEGORY = "statement";
export const CARD_KINDS = ["credit_card", "bank"] as const;
export type CardKind = (typeof CARD_KINDS)[number];

/** null 視為信用卡(既有 RCS-010~019 還沒分類的先當信用卡顯示,Theo 在卡片設定按「這是銀行帳戶」隱藏)。 */
export function isCreditCardSeries(s: { category?: string | null; cardKind?: string | null }): boolean {
  return s.category === CARD_CATEGORY && s.cardKind !== "bank";
}

/** 對帳單類 series(信用卡 + 銀行帳戶):不是支出,/recurring、月報表、每日通知都排除。 */
export function isStatementSeries(s: { category?: string | null }): boolean {
  return s.category === CARD_CATEGORY;
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
function idx(m: string): number {
  const r = MONTH_RE.exec(m);
  if (!r) throw new Error(`月份格式錯誤:${m}`);
  return Number(r[1]) * 12 + Number(r[2]) - 1;
}
function fromIdx(i: number): string {
  return `${String(Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`;
}

/** 台北時間的當月 YYYY-MM。 */
export function currentMonthTaipeiOf(now: Date = new Date()): string {
  const t = new Date(now.getTime() + 8 * 3600e3);
  return fromIdx(t.getUTCFullYear() * 12 + t.getUTCMonth());
}

/** 每期金額預設 = 原始金額 / 期數 無條件捨去到元(分為單位、取 100 的倍數),尾差由最後一期吸收。 */
export function defaultPerPeriodCents(totalCents: number, periodCount: number): number {
  if (periodCount < 1) return totalCents;
  return Math.floor(totalCents / periodCount / 100) * 100;
}

/** 第 n 期(1-based)的金額:最後一期 = 原始金額 − 前面各期。 */
export function installmentAmountOf(plan: { totalCents: number; periodCount: number; perPeriodCents: number }, n: number): number {
  if (n < 1 || n > plan.periodCount) return 0;
  if (n < plan.periodCount) return plan.perPeriodCents;
  return plan.totalCents - plan.perPeriodCents * (plan.periodCount - 1);
}

export interface InstallmentProgress {
  /** 截至當月(含)已進帳單的期數。 */
  billedCount: number;
  remainingCount: number;
  /** 當月這張帳單上的分期金額(沒有就是 0)。 */
  thisMonthCents: number;
  /** 當月之後還沒進帳單的金額。 */
  remainingCents: number;
  lastMonth: string;
  /** 'upcoming' 首期還沒到 / 'active' 繳款中 / 'done' 已繳完 / 'cancelled'。 */
  state: "upcoming" | "active" | "done" | "cancelled";
}

export function installmentProgress(
  plan: { totalCents: number; periodCount: number; perPeriodCents: number; firstMonth: string; status: string },
  month: string,
): InstallmentProgress {
  const lastMonth = fromIdx(idx(plan.firstMonth) + plan.periodCount - 1);
  if (plan.status === "cancelled") return { billedCount: 0, remainingCount: 0, thisMonthCents: 0, remainingCents: 0, lastMonth, state: "cancelled" };
  const billedCount = Math.max(0, Math.min(plan.periodCount, idx(month) - idx(plan.firstMonth) + 1));
  let billedCents = 0;
  for (let n = 1; n <= billedCount; n++) billedCents += installmentAmountOf(plan, n);
  return {
    billedCount,
    remainingCount: plan.periodCount - billedCount,
    thisMonthCents: billedCount >= 1 && idx(month) <= idx(lastMonth) ? installmentAmountOf(plan, billedCount) : 0,
    remainingCents: plan.totalCents - billedCents,
    lastMonth,
    state: billedCount === 0 ? "upcoming" : billedCount >= plan.periodCount ? "done" : "active",
  };
}
