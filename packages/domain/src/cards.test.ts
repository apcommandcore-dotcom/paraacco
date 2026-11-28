import { describe, expect, it } from "vitest";
import { defaultPerPeriodCents, installmentAmountOf, installmentProgress, isCreditCardSeries, isStatementSeries } from "./cards";

const plan = { totalCents: 1000000, periodCount: 3, perPeriodCents: defaultPerPeriodCents(1000000, 3), firstMonth: "2026-11", status: "active" };

describe("installments", () => {
  it("每期捨去到元、最後一期吸收尾差", () => {
    expect(plan.perPeriodCents).toBe(333300);
    expect(installmentAmountOf(plan, 3)).toBe(333400);
  });
  it("進度依帳單月份計算", () => {
    expect(installmentProgress(plan, "2026-10")).toMatchObject({ state: "upcoming", billedCount: 0, thisMonthCents: 0, remainingCents: 1000000, lastMonth: "2027-01" });
    expect(installmentProgress(plan, "2026-12")).toMatchObject({ state: "active", billedCount: 2, thisMonthCents: 333300, remainingCents: 333400 });
    expect(installmentProgress(plan, "2027-01")).toMatchObject({ state: "done", billedCount: 3, thisMonthCents: 333400, remainingCents: 0 });
    expect(installmentProgress(plan, "2027-03")).toMatchObject({ state: "done", thisMonthCents: 0, remainingCents: 0 });
    expect(installmentProgress({ ...plan, status: "cancelled" }, "2026-12").state).toBe("cancelled");
  });
});

describe("card series", () => {
  it("statement + 非 bank 才是信用卡", () => {
    expect(isCreditCardSeries({ category: "statement", cardKind: null })).toBe(true);
    expect(isCreditCardSeries({ category: "statement", cardKind: "bank" })).toBe(false);
    expect(isCreditCardSeries({ category: "water", cardKind: null })).toBe(false);
    expect(isStatementSeries({ category: "statement" })).toBe(true);
  });
});
