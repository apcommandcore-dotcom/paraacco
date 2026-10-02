import { describe, expect, it } from "vitest";
import {
  billingMonthFieldKey,
  computeCoverage,
  expectedMonths,
  isBillingMonthFieldKey,
  lastCompleteMonth,
  suggestBillingMonths,
  suggestSeries,
} from "./recurring";

describe("expectedMonths", () => {
  it("月繳:含起訖", () => {
    expect(expectedMonths({ cadence: "monthly", startMonth: "2025-11", endMonth: null }, "2025-10", "2026-02")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });
  it("雙月:只取偶數/奇數月", () => {
    expect(expectedMonths({ cadence: "bimonthly_even", startMonth: "2022-10", endMonth: null }, "2022-01", "2023-03")).toEqual([
      "2022-10",
      "2022-12",
      "2023-02",
    ]);
    expect(expectedMonths({ cadence: "bimonthly_odd", startMonth: "2023-01", endMonth: "2023-06" }, "2020-01", "2030-01")).toEqual([
      "2023-01",
      "2023-03",
      "2023-05",
    ]);
  });
  it("已停止的 series 不超過 endMonth;年繳取起始月份", () => {
    expect(expectedMonths({ cadence: "monthly", startMonth: "2023-07", endMonth: "2023-08" }, "2023-01", "2026-08")).toEqual(["2023-07", "2023-08"]);
    expect(expectedMonths({ cadence: "yearly", startMonth: "2024-05", endMonth: null }, "2024-01", "2026-12")).toEqual([
      "2024-05",
      "2025-05",
      "2026-05",
    ]);
  });
});

describe("computeCoverage", () => {
  const series = { cadence: "monthly" as const, startMonth: "2025-09", endMonth: null };
  it("有/只有催繳/人工標記/缺,摘要只算應有月份", () => {
    const docs = new Map([
      ["2025-09", [{ documentId: "DOC-1", isReminder: false }]],
      ["2025-10", [{ documentId: "DOC-2", isReminder: true }]],
      ["2025-11", [{ documentId: "DOC-3", isReminder: true }, { documentId: "DOC-4", isReminder: false }]],
    ]);
    const r = computeCoverage(series, "2025-09", "2026-01", docs, [
      { month: "2025-12", status: "not_required", note: "無消費" },
      { month: "2026-01", status: "encrypted", note: null },
    ]);
    expect(r.months.map((m) => [m.month, m.status])).toEqual([
      ["2025-09", "present"],
      ["2025-10", "reminder_only"],
      ["2025-11", "present"],
      ["2025-12", "not_required"],
      ["2026-01", "encrypted"],
    ]);
    expect(r.months[2].reminderDocumentIds).toEqual(["DOC-3"]);
    expect(r.summary).toEqual({ expected: 5, present: 2, reminderOnly: 1, encrypted: 1, notRequired: 1, missing: 0 });
  });
  it("不在 cadence 內的月份有文件時也列出,但不計入摘要", () => {
    const r = computeCoverage(
      { cadence: "bimonthly_even", startMonth: "2026-02", endMonth: null },
      "2026-01",
      "2026-04",
      new Map([["2026-03", [{ documentId: "DOC-9", isReminder: false }]]]),
      [],
    );
    expect(r.months.map((m) => [m.month, m.status, m.expected])).toEqual([
      ["2026-02", "missing", true],
      ["2026-03", "present", false],
      ["2026-04", "missing", true],
    ]);
    expect(r.summary.missing).toBe(2);
    expect(r.summary.present).toBe(0);
  });
});

describe("billing_month 欄位鍵", () => {
  it("第一個月 billing_month,其後 _2、_3", () => {
    expect([0, 1, 2].map(billingMonthFieldKey)).toEqual(["billing_month", "billing_month_2", "billing_month_3"]);
    expect(isBillingMonthFieldKey("billing_month_2")).toBe(true);
    expect(isBillingMonthFieldKey("billing_months")).toBe(false);
  });
});

describe("系統建議", () => {
  it("統編 > 名稱關鍵字,分數不到門檻不建議", () => {
    const series = [
      { id: "RCS-001", matchRule: JSON.stringify({ vendorNameKeywords: ["自來水"] }) },
      { id: "RCS-002", matchRule: JSON.stringify({ vendorTaxId: "03795904", vendorNameKeywords: ["台灣電力"] }) },
    ];
    expect(suggestSeries(series, { vendorTaxId: "03795904", vendorNameRaw: "台灣電力股份有限公司", texts: [] })).toEqual({
      seriesId: "RCS-002",
      score: 90,
    });
    expect(suggestSeries(series, { vendorTaxId: null, vendorNameRaw: "某商店", texts: [] })).toBeNull();
  });
  it("帳單月份:期別區間展開、民國年換算、退回單據日期", () => {
    expect(suggestBillingMonths({ invoicePeriod: "2026-07~2026-08" })).toEqual(["2026-07", "2026-08"]);
    expect(suggestBillingMonths({ invoicePeriod: "2026-05" })).toEqual(["2026-05"]);
    expect(suggestBillingMonths({ invoicePeriod: "115/03" })).toEqual(["2026-03"]);
    expect(suggestBillingMonths({ invoicePeriod: null, docDate: "2025-12-15" })).toEqual(["2025-12"]);
  });
  it("lastCompleteMonth 以台北時間判斷", () => {
    expect(lastCompleteMonth(new Date("2026-09-30T17:00:00Z"))).toBe("2026-09"); // 台北已是 10/1
    expect(lastCompleteMonth(new Date("2026-09-27T03:00:00Z"))).toBe("2026-08");
  });
});
