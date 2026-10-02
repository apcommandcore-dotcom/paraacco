import { describe, expect, it } from "vitest";
import {
  applyDocumentToPeriod,
  documentRoleOf,
  estimateDueDate,
  expectedPeriods,
  matchDocumentSeries,
  matchStatementDebit,
  periodDisplayStatus,
  periodForDocument,
  periodForMonth,
  type PeriodSeries,
} from "./recurring-periods";

// 2026-10-01 CODE_TASK_recurring-bills-single-page_20260929_V1.04.md 第二~四、八節。
const WATER: PeriodSeries = {
  id: "RCS-001",
  cadence: "bimonthly_even",
  startMonth: "2022-10",
  endMonth: null,
  paymentMethod: "auto_debit",
  dueRule: "bill",
  dueDay: 15,
  amountMode: "variable",
  amountCents: null,
  requireProof: false,
  remindDays: 7,
  matchRule: JSON.stringify({ vendorTaxId: "03774909", accountRefs: ["L-13-024736-1", "C108001950"], statementKeywords: ["台北自來水"] }),
};
const PENSION: PeriodSeries = {
  ...WATER,
  id: "RCS-008",
  cadence: "monthly",
  paymentMethod: "auto_debit",
  amountMode: "fixed",
  amountCents: 600000,
  requireProof: true,
  matchRule: JSON.stringify({ statementKeywords: ["勞退"] }),
};
const now = new Date("2026-10-01T04:00:00Z");

describe("期次", () => {
  it("雙月一期兩個月:billing_month 2026-08(115年07-08月)→ 期次 2026-07,涵蓋 07、08", () => {
    expect(periodForMonth(WATER, "2026-08")).toEqual({ periodKey: "2026-07", months: ["2026-07", "2026-08"], expectedMonth: "2026-08" });
    expect(periodForMonth(WATER, "2026-07").periodKey).toBe("2026-07");
    expect(periodForMonth(PENSION, "2026-07")).toEqual({ periodKey: "2026-07", months: ["2026-07"], expectedMonth: "2026-07" });
    expect(expectedPeriods(WATER, "2026-01", "2026-06").map((p) => p.periodKey)).toEqual(["2026-01", "2026-03", "2026-05"]);
    expect(periodForDocument(WATER, { billingMonths: ["2026-08"], docDate: null })?.periodKey).toBe("2026-07");
    expect(periodForDocument(WATER, { billingMonths: [], docDate: "2026-04-23" })?.periodKey).toBe("2026-03");
  });

  it("繳費期限:帳單上的優先;否則期末次月 N 日(月底對齊)", () => {
    expect(estimateDueDate(WATER, ["2026-07", "2026-08"], "2026-09-03")).toEqual({ dueDate: "2026-09-03", source: "bill" });
    expect(estimateDueDate({ dueRule: "bill", dueDay: 31 }, ["2026-01"]).dueDate).toBe("2026-02-28");
    expect(estimateDueDate({ dueRule: "fixed_day", dueDay: 10 }, ["2026-01"]).dueDate).toBe("2026-01-10");
  });
});

describe("畫面狀態(避免假的逾期未繳)", () => {
  const base = { months: ["2026-07", "2026-08"], status: "billed" as const, dueDate: "2026-09-03", billDocId: "DOC-1", statementLineId: null };
  it("自動扣款已過繳費日,對帳單還沒匯入 → 待對帳;已匯入仍找不到扣款 → 逾期未繳", () => {
    expect(periodDisplayStatus(base, WATER, now, { statementCoveredThrough: null })).toBe("pending_statement");
    expect(periodDisplayStatus(base, WATER, now, { statementCoveredThrough: "2026-09-30" })).toBe("overdue");
    expect(periodDisplayStatus(base, { ...WATER, paymentMethod: "manual" }, now, { statementCoveredThrough: null })).toBe("overdue");
  });
  it("帳單未到:預期帳單日 + 30 天才出現", () => {
    const p = { months: ["2026-07", "2026-08"], status: "expected" as const, dueDate: "2026-09-15", billDocId: null, statementLineId: null };
    expect(periodDisplayStatus(p, WATER, new Date("2026-09-25T04:00:00Z"), { statementCoveredThrough: null })).toBe("pending_statement");
    expect(periodDisplayStatus(p, WATER, new Date("2026-10-01T04:00:00Z"), { statementCoveredThrough: null })).toBe("bill_missing");
    expect(periodDisplayStatus(p, WATER, new Date("2026-10-01T04:00:00Z"), { statementCoveredThrough: null, graceDays: 60 })).toBe("pending_statement");
  });
  it("require_proof 只有扣款 → 已扣款、缺證明;過期限 + 30 天 → 缺繳款證明", () => {
    const p = { months: ["2026-09"], status: "debited" as const, dueDate: "2026-09-30", billDocId: null, statementLineId: 1 };
    expect(periodDisplayStatus(p, PENSION, now, { statementCoveredThrough: "2026-09-30" })).toBe("debited");
    expect(periodDisplayStatus(p, PENSION, new Date("2026-11-05T04:00:00Z"), { statementCoveredThrough: "2026-09-30" })).toBe("proof_missing");
  });
  it("即將繳費 / 未到期", () => {
    const p = { ...base, dueDate: "2026-10-05" };
    expect(periodDisplayStatus(p, WATER, now, { statementCoveredThrough: null })).toBe("due_soon");
    expect(periodDisplayStatus({ ...p, dueDate: "2026-11-05" }, WATER, now, { statementCoveredThrough: null })).toBe("not_due");
  });
});

describe("文件 → 項目/期次", () => {
  const series = [WATER, { ...WATER, id: "RCS-002", matchRule: JSON.stringify({ vendorTaxId: "31096199" }) }];
  it("統編 + 用戶號碼 → 高信心;只中統編且唯一 → 中信心;統編未建檔 → 待覆核", () => {
    expect(matchDocumentSeries({ vendorTaxId: "03774909", vendorRegistered: true, texts: ["用戶號碼 L13024736-1"] }, series)).toMatchObject({ kind: "auto", seriesId: "RCS-001" });
    expect(matchDocumentSeries({ vendorTaxId: "03774909", vendorRegistered: true, texts: [] }, series)).toMatchObject({ kind: "review", reason: "medium_confidence" });
    expect(matchDocumentSeries({ vendorTaxId: "31096199", vendorRegistered: false, texts: [] }, series)).toMatchObject({ kind: "review", reason: "vendor_unregistered", seriesId: "RCS-002" });
    expect(matchDocumentSeries({ vendorTaxId: "24794037", vendorRegistered: true, texts: [] }, series)).toEqual({ kind: "none" });
  });
  it("角色:收據 → 證明;繳費通知 → 帳單;超商代收 → 帳單兼證明", () => {
    expect(documentRoleOf({ fileTypeLabel: "收據" })).toBe("proof");
    expect(documentRoleOf({ texts: ["水費繳費通知"] })).toBe("bill");
    expect(documentRoleOf({ texts: ["超商代收 繳費單 收據聯"] })).toBe("bill_and_proof");
    expect(documentRoleOf({ documentRole: "proof", fileTypeLabel: "帳單" })).toBe("proof");
  });
  it("帳單掛上 → billed;證明 → paid;同一期第二份帳單 → 不覆蓋", () => {
    const empty = { billDocId: null, proofDocId: null, statementLineId: null, status: "expected" as const, amountCents: null, dueDate: "2026-09-15", dueDateSource: "estimated" };
    expect(applyDocumentToPeriod(empty, "bill", { id: "D1", amountCents: 69600, billDueDate: "2026-09-03", date: "2026-08-28" })).toEqual({
      patch: { billDocId: "D1", amountCents: 69600, dueDate: "2026-09-03", dueDateSource: "bill", billMissingFlag: false, status: "billed" },
      conflict: null,
    });
    expect(applyDocumentToPeriod({ ...empty, billDocId: "D1", status: "billed" }, "proof", { id: "D2", amountCents: 69600, billDueDate: null, date: "2026-09-02" }).patch).toMatchObject({ status: "paid", paidSource: "proof", proofDocId: "D2" });
    expect(applyDocumentToPeriod({ ...empty, billDocId: "D1", status: "billed" }, "bill", { id: "D3", amountCents: 1, billDueDate: null, date: null }).conflict).toBe("duplicate_bill");
  });
});

describe("對帳單扣款 → 期次", () => {
  const periods = [
    { periodKey: "2026-07", months: ["2026-07", "2026-08"], billDocId: "D1", proofDocId: null, statementLineId: null, status: "billed" as const, amountCents: 69600, dueDate: "2026-09-03", dueDateSource: "bill" },
  ];
  it("關鍵字 + 金額 + 日期唯一命中 → 已繳(對帳單)", () => {
    const r = matchStatementDebit({ id: 9, date: "2026-09-04", amountCents: 69600, description: "台北自來水費 自動扣繳" }, [{ series: WATER, periods }]);
    expect(r).toMatchObject({ kind: "match", seriesId: "RCS-001", periodKey: "2026-07", status: "paid", billMissing: false, create: false });
  });
  it("金額不符 → 待覆核;沒有關鍵字 → 不掛", () => {
    expect(matchStatementDebit({ id: 9, date: "2026-09-04", amountCents: 70000, description: "台北自來水" }, [{ series: WATER, periods }])).toMatchObject({ kind: "review", reason: "amount_mismatch" });
    expect(matchStatementDebit({ id: 9, date: "2026-09-04", amountCents: 69600, description: "全聯" }, [{ series: WATER, periods }])).toEqual({ kind: "none" });
  });
  it("帳單還沒到、扣款先到 → 建立期次、標帳單未到", () => {
    const r = matchStatementDebit({ id: 9, date: "2026-11-14", amountCents: 70000, description: "台北自來水" }, [{ series: WATER, periods }]);
    expect(r).toMatchObject({ kind: "match", periodKey: "2026-09", create: true, billMissing: true, status: "paid", amountCents: 70000 });
  });
  it("require_proof(勞退)扣款只到 debited", () => {
    const r = matchStatementDebit({ id: 9, date: "2026-10-14", amountCents: 600000, description: "勞退提繳" }, [{ series: PENSION, periods: [] }]);
    expect(r).toMatchObject({ kind: "match", status: "debited", seriesId: "RCS-008" });
  });
});
