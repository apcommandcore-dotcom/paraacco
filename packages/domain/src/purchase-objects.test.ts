import { describe, expect, it } from "vitest";
import {
  buildMergeSuggestions,
  buildMonthlyReport,
  docKindOf,
  findMergePairs,
  itemAmountMismatch,
  itemsFromLineItems,
  isMixedOwnership,
  mixedOwnershipNeedsWarning,
  namesSimilar,
  normalizeInvoiceNo,
  pickItemRule,
  pickPrimary,
  shouldTakeOverPrimary,
  splitAmountByOwnership,
  splitItem,
  UNCATEGORIZED,
  type MergeDoc,
  type ReportDocInput,
} from "./purchase-objects";

// 2026-09-29 CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md 第四、六節。

const P = "Paraacco_公司財務系統/10_平行空間有限公司/2026/01_發票收據/";
function doc(id: string, file: string, o: Partial<MergeDoc>): MergeDoc {
  return {
    id,
    kind: docKindOf({ localPath: P + file, invoiceNo: o.invoiceNo ?? null }),
    status: "review",
    ownership: "corp",
    vendorTaxId: null,
    vendorName: null,
    date: null,
    amountCents: null,
    invoiceNo: null,
    orderNo: null,
    brand: null,
    model: null,
    serialNo: null,
    ...o,
  };
}

// 正式 D1 快照(2026-09-29)裡第四節那幾份文件的實際欄位值。
const SEP = [
  doc("DOC-2026-000031", "20260910_收據_好市多北投店_5768_DOC-2026-000031.pdf", { ownership: "per", date: "2026-09-10", amountCents: 576800, vendorName: "好市多北投店" }),
  doc("DOC-2026-000036", "20260912_收據_大葉髙島屋_648_DOC-2026-000036.pdf", { ownership: "per", date: "2026-09-12", amountCents: 64800, vendorName: "大葉髙島屋" }),
  doc("DOC-2026-000039", "20260910_發票_COSTCOWHOLES_5768_DOC-2026-000039.pdf", { date: "2026-09-10", amountCents: 576800, invoiceNo: "FK60843488", vendorName: "COSTCO WHOLESALE 北投店 #5009" }),
  doc("DOC-2026-000041", "20260910_發票_COSTCOWHOLES_69_DOC-2026-000041.pdf", { date: "2026-09-10", amountCents: 6900, invoiceNo: "FK60843564", vendorName: "COSTCO WHOLESALE 北投店 #5009 FOOD COURT" }),
  doc("DOC-2026-000043", "20260910_發票_好市多北投_69_DOC-2026-000043.pdf", { date: "2026-09-10", amountCents: 6900, invoiceNo: "FK-60843564", vendorName: "好市多股份有限公司 北投分公司", vendorTaxId: "24794037" }),
  doc("DOC-2026-000044", "20260910_收據_好市多北投店_69_DOC-2026-000044.pdf", { ownership: "per", date: "2026-09-10", amountCents: 6900, vendorName: "好市多北投店" }),
  doc("DOC-2026-000050", "20260912_收據_台灣無印良品_648_DOC-2026-000050.pdf", { ownership: "per", date: "2026-09-12", amountCents: 64800, vendorName: "台灣無印良品股份有限公司" }),
  doc("DOC-2026-000051", "20260912_發票_大葉高島屋百貨_648_DOC-2026-000051.pdf", { date: "2026-09-12", amountCents: 64800, invoiceNo: "FK-02825074", vendorName: "大葉高島屋百貨股份有限公司", vendorTaxId: "86382689" }),
  doc("DOC-2026-000054", "20260908_收據_未知_320_DOC-2026-000054.pdf", { date: "2026-09-08", amountCents: 32000 }),
  doc("DOC-2026-000055", "20260908_發票_未知_320_DOC-2026-000055.pdf", { date: "2026-09-08", amountCents: 32000, invoiceNo: "FG-35842095", vendorTaxId: "40991689" }),
  doc("DOC-2026-000111", "20260908_發票_士東企業_770_DOC-2026-000111.pdf", { date: "2026-09-08", amountCents: 77000, invoiceNo: "FD-52990572", vendorName: "士東企業有限公司", vendorTaxId: "01814784" }),
  doc("DOC-2026-000116", "20260908_收據_士東企業_770_DOC-2026-000116.pdf", { ownership: "per", date: "2026-09-08", amountCents: 77000, vendorName: "士東企業有限公司" }),
];

describe("基本規則", () => {
  it("發票號碼正規化、文件種類", () => {
    expect(normalizeInvoiceNo("FK-6084 3564")).toBe("FK60843564");
    expect(docKindOf({ localPath: P + "20260910_收據_好市多北投店_69_DOC-2026-000044.pdf" })).toBe("receipt");
    expect(docKindOf({ docTypeCode: "DEL" })).toBe("delivery");
    expect(docKindOf({ invoiceNo: "fk-60843564" })).toBe("invoice");
  });

  it("主文件:發票優先;沒有發票時收據暫代,發票進來自動接手", () => {
    const receipt = { id: "A", kind: "receipt" as const, date: "2026-09-01" };
    const invoice = { id: "B", kind: "invoice" as const, date: "2026-09-05" };
    expect(pickPrimary([receipt])?.id).toBe("A");
    expect(pickPrimary([receipt, invoice])?.id).toBe("B");
    expect(shouldTakeOverPrimary("invoice", "receipt")).toBe(true);
    expect(shouldTakeOverPrimary("invoice", "invoice")).toBe(false);
    expect(shouldTakeOverPrimary("delivery", "receipt")).toBe(false);
  });

  it("店名相近:好市多 = COSTCO、髙島屋 = 高島屋;無印良品 ≠ 高島屋", () => {
    expect(namesSimilar("好市多北投店", "COSTCO WHOLESALE 北投店 #5009")).toBe(true);
    expect(namesSimilar("大葉髙島屋", "大葉高島屋百貨股份有限公司")).toBe(true);
    expect(namesSimilar("台灣無印良品股份有限公司", "大葉高島屋百貨股份有限公司")).toBe(false);
  });
});

describe("品項", () => {
  it("一張 5 行明細的發票自動建立 5 個品項;相符不警告,不符標「品項金額不符」", () => {
    const json = JSON.stringify([
      { name: "A", qty: 1, amount: 100 },
      { name: "B", qty: 2, unitPrice: 50, amount: 100 },
      { name: "C", qty: 1, amount: 300 },
      { name: "D", qty: 3, unitPrice: 10 },
      { name: "折價券", amount: -30 },
    ]);
    const items = itemsFromLineItems(json);
    expect(items).toHaveLength(5);
    expect(items[3]).toMatchObject({ quantity: 3, unitPriceCents: 1000, amountCents: 3000 });
    expect(items[4].amountCents).toBe(-3000); // 折扣行也是品項(負數),不另外分攤
    expect(itemAmountMismatch(50000, items)).toBe(false);
    expect(itemAmountMismatch(50100, items)).toBe(true);
    expect(itemAmountMismatch(50100, [])).toBe(false);
  });

  it("士東企業 FD-52990572:品項 133 + 600 = 733 ≠ 發票 770 → 品項金額不符", () => {
    const items = itemsFromLineItems(
      JSON.stringify([
        { name: "3M 紙膠帶(藍色)", code: "ABE495", qty: 7, unitPrice: 19, amount: 133 },
        { name: "工程帽(白色)", code: "AAI997", qty: 5, unitPrice: 120, amount: 600 },
      ]),
    );
    expect(items.map((i) => i.amountCents)).toEqual([13300, 60000]);
    expect(itemAmountMismatch(77000, items)).toBe(true);
  });

  it("數量 2 拆成兩個品項,金額照比例、尾差放第一個", () => {
    expect(splitItem({ quantity: 2, amountCents: 1001, unitPriceCents: null }, [1, 1])).toEqual([
      { quantity: 1, amountCents: 501 },
      { quantity: 1, amountCents: 500 },
    ]);
    expect(() => splitItem({ quantity: 2, amountCents: 1000, unitPriceCents: null }, [1, 2])).toThrow();
  });

  it("品項改歸屬:小計依品項拆分、總計不變;差額歸發票歸屬", () => {
    const items = [
      { amountCents: 13300, ownership: "per" },
      { amountCents: 60000, ownership: null },
    ];
    expect(isMixedOwnership("corp", items)).toBe(true);
    const split = splitAmountByOwnership("corp", 77000, items);
    expect(split).toEqual({ per: 13300, corp: 63700 });
    expect(split.per + split.corp).toBe(77000);
    expect(splitAmountByOwnership("corp", 77000, [{ amountCents: 1, ownership: null }])).toEqual({ corp: 77000 });
  });

  it("混合歸屬警告:截止日(2026-10-01)之後才警告,截止日前不警告", () => {
    expect(mixedOwnershipNeedsWarning("2026-10-01", true)).toBe(true);
    expect(mixedOwnershipNeedsWarning("2026-09-30", true)).toBe(false);
    expect(mixedOwnershipNeedsWarning("2026-10-05", false)).toBe(false);
    expect(mixedOwnershipNeedsWarning("2026-10-05", true, "2026-11-01")).toBe(false);
  });
});

describe("自動合併建議(第四節 2026-09 案例)", () => {
  const { objects, duplicates } = buildMergeSuggestions(SEP);
  const byPrimary = new Map(objects.map((o) => [o.primaryId, o]));

  it("同發票號不同寫法(FK60843564 / FK-60843564)→ 重複檔,不是附件", () => {
    expect(duplicates).toEqual([expect.objectContaining({ keepId: "DOC-2026-000041", duplicateId: "DOC-2026-000043" })]);
    expect(objects.flatMap((o) => o.attachments.map((a) => a.documentId))).not.toContain("DOC-2026-000043");
  });

  it("好市多 NT$5,768:COSTCO 發票為主、好市多收據為附件,歸屬衝突", () => {
    expect(byPrimary.get("DOC-2026-000039")).toMatchObject({
      ownershipConflict: true,
      attachments: [expect.objectContaining({ documentId: "DOC-2026-000031", rule: 4, role: "RET", uncertain: true })],
    });
  });

  it("好市多 Food Court NT$69:收據 000044 → 附件", () => {
    expect(byPrimary.get("DOC-2026-000041")?.attachments.map((a) => a.documentId)).toEqual(["DOC-2026-000044"]);
  });

  it("士東企業 NT$770:000116 → 附件,歸屬衝突", () => {
    expect(byPrimary.get("DOC-2026-000111")).toMatchObject({ ownershipConflict: true, attachments: [expect.objectContaining({ documentId: "DOC-2026-000116", rule: 4 })] });
  });

  it("大葉高島屋 NT$648:000036、000050 → 附件;000050 店名不相近要確認", () => {
    const o = byPrimary.get("DOC-2026-000051")!;
    expect(o.attachments.map((a) => a.documentId)).toEqual(["DOC-2026-000036", "DOC-2026-000050"]);
    expect(o.attachments.find((a) => a.documentId === "DOC-2026-000050")?.note).toContain("店名不相近");
  });

  it("2026-09-08 NT$320:000054 → 附件(店名缺漏)", () => {
    expect(byPrimary.get("DOC-2026-000055")?.attachments.map((a) => a.documentId)).toEqual(["DOC-2026-000054"]);
  });

  it("兩張不同號碼的發票不會被合併;說明書對到品項", () => {
    const pairs = findMergePairs([
      doc("I1", "20260901_發票_x_100_I1.pdf", { invoiceNo: "AB11111111", amountCents: 100, date: "2026-09-01" }),
      doc("I2", "20260901_發票_x_100_I2.pdf", { invoiceNo: "AB22222222", amountCents: 100, date: "2026-09-01" }),
    ]);
    expect(pairs).toEqual([]);
    const inv = doc("I3", "20260901_發票_x_5000_I3.pdf", {
      invoiceNo: "AB33333333",
      date: "2026-09-01",
      items: [
        { lineNo: 1, name: "吸塵器 V12", brand: "Dyson", model: "V12", serialNo: null },
        { lineNo: 2, name: "濾網", brand: null, model: null, serialNo: null },
      ],
    });
    const man = doc("M1", "20260905_說明書_Dyson_M1.pdf", { brand: "Dyson", model: "V12", date: "2026-09-05" });
    const { objects: o2 } = buildMergeSuggestions([inv, man]);
    expect(o2[0]).toMatchObject({ primaryId: "I3", attachments: [expect.objectContaining({ documentId: "M1", rule: 5, role: "MAN", itemLineNo: 1 })] });
  });
});

describe("月報表(以物件為列)", () => {
  const base = (id: string, o: Partial<ReportDocInput>): ReportDocInput => ({
    id,
    status: "review",
    ownership: "corp",
    invoiceDate: "2026-09-10",
    docDate: null,
    vendorName: null,
    vendorNameRaw: "店",
    invoiceNo: null,
    amountCents: 1000,
    displayName: null,
    recurringSeriesId: null,
    kind: "invoice",
    ...o,
  });
  const docs = [
    base("INV", { amountCents: 77000 }),
    base("RCPT", { ownership: "per", amountCents: 77000, kind: "receipt" }),
    base("SOLO", { amountCents: 5000 }),
    base("WATER", { ownership: "per", amountCents: 69600, recurringSeriesId: "RCS-001" }),
    base("DUP", { status: "dup", amountCents: 999 }),
    base("AUG", { invoiceDate: "2026-08-31" }),
    base("NODATE", { invoiceDate: null }),
  ];
  const links = [
    { documentId: "INV", purchaseId: "PUR-1", relationKind: "primary", attachmentRole: null, purchaseItemId: null },
    { documentId: "RCPT", purchaseId: "PUR-1", relationKind: "supporting", attachmentRole: "RET", purchaseItemId: null },
  ];
  const items = [
    { id: "PIT-1", purchaseId: "PUR-1", lineNo: 1, name: "紙膠帶", quantity: 7, unitPriceCents: 1900, amountCents: 13300, ownership: "per" },
    { id: "PIT-2", purchaseId: "PUR-1", lineNo: 2, name: "工程帽", quantity: 5, unitPriceCents: 12000, amountCents: 60000, ownership: null },
  ];
  const report = buildMonthlyReport({
    month: "2026-09",
    docs,
    links,
    items,
    attachments: [{ purchaseId: "PUR-1", purchaseItemId: "PIT-2", kind: "video" }],
    statusFilter: (s) => s !== "dup" && s !== "failed",
  });

  it("附件不計金額、不自成一列;定期繳費/一般消費兩段小計加總 = 總計", () => {
    expect(report.general.rows.map((r) => r.key)).toEqual(["PUR-1", "SOLO"]);
    expect(report.recurring.rows.map((r) => r.key)).toEqual(["WATER"]);
    expect(report.general.subtotals.cents).toBe(82000);
    expect(report.recurring.subtotals.cents).toBe(69600);
    expect(report.total.cents).toBe(report.general.subtotals.cents + report.recurring.subtotals.cents);
    expect(report.noDate).toBe(1);
  });

  it("附件摘要、品項、混合歸屬拆分(公司/個人小計依品項)", () => {
    const row = report.general.rows[0];
    expect(row.attachmentSummary).toBe("收據 1・影片 1");
    expect(row.items.map((i) => [i.name, i.effectiveOwnership, i.attachmentCount])).toEqual([
      ["紙膠帶", "per", 0],
      ["工程帽", "corp", 1],
    ]);
    expect(row).toMatchObject({ mixedOwnership: true, itemAmountMismatch: true, needsConfirm: false });
    expect(report.general.subtotals.byOwnership).toEqual({ corp: { count: 2, cents: 68700 }, per: { count: 0, cents: 13300 } });
  });

  it("截止日後的混合歸屬列入待確認", () => {
    const r2 = buildMonthlyReport({
      month: "2026-10",
      docs: [base("OCT", { invoiceDate: "2026-10-02", amountCents: 77000 })],
      links: [{ documentId: "OCT", purchaseId: "PUR-9", relationKind: "primary", attachmentRole: null, purchaseItemId: null }],
      items: [{ ...items[0], purchaseId: "PUR-9" }],
      attachments: [],
      statusFilter: () => true,
    });
    expect(r2.pendingConfirm).toEqual(["PUR-9"]);
  });
});

// 2026-10-01 V1.02 第七節

describe("品項自動規則與月報表類別/專案小計", () => {
  const rules = [
    { id: 1, vendorTaxId: "24794037", nameKeyword: null, categoryId: "ICT-012", ownership: null, projectCode: null, isActive: true },
    { id: 2, vendorTaxId: "24794037", nameKeyword: "牛乳", categoryId: "ICT-001", ownership: "per", projectCode: null, isActive: true },
    { id: 3, vendorTaxId: "24794037", nameKeyword: null, categoryId: "ICT-003", ownership: null, projectCode: null, isActive: true },
    { id: 4, vendorTaxId: "24794037", nameKeyword: "牛乳", categoryId: "ICT-009", ownership: null, projectCode: null, isActive: false },
  ];
  it("有品名關鍵字的優先,再以最新建立者優先;停用的不套用", () => {
    expect(pickItemRule(rules, "24794037", "科克蘭全脂牛乳")?.id).toBe(2);
    expect(pickItemRule(rules, "24794037", "迷你葡萄乾鬆餅")?.id).toBe(3);
    expect(pickItemRule(rules, "86382689", "牛乳")).toBeNull();
  });

  it("類別/專案小計加總 = 總計;不列帳不計入、代墊另列", () => {
    const r = buildMonthlyReport({
      month: "2026-09",
      docs: [
        { id: "INV", status: "review", ownership: "corp", invoiceDate: "2026-09-08", docDate: null, vendorName: "士東", vendorNameRaw: null, invoiceNo: null, amountCents: 77000, displayName: null, recurringSeriesId: null, kind: "invoice" },
        { id: "SOLO", status: "review", ownership: "per", invoiceDate: "2026-09-09", docDate: null, vendorName: null, vendorNameRaw: "x", invoiceNo: null, amountCents: 1000, displayName: null, recurringSeriesId: null, kind: "receipt" },
      ],
      links: [{ documentId: "INV", purchaseId: "P1", relationKind: "primary", attachmentRole: null, purchaseItemId: null }],
      items: [
        { id: "I1", purchaseId: "P1", lineNo: 1, name: "紙膠帶", quantity: 7, unitPriceCents: 1900, amountCents: 13300, ownership: null, categoryId: "ICT-003", projectCode: "AP_26001" },
        { id: "I2", purchaseId: "P1", lineNo: 2, name: "工程帽", quantity: 5, unitPriceCents: 12000, amountCents: 60000, ownership: null, categoryId: "ICT-005", isAdvance: true, advancePayee: "owner" },
        { id: "I3", purchaseId: "P1", lineNo: 3, name: "退貨", quantity: 1, unitPriceCents: null, amountCents: 3000, ownership: null, excludeFromReport: true, excludeReason: "已退貨" },
      ],
      attachments: [],
      statusFilter: () => true,
    });
    expect(r.total.cents).toBe(77000 - 3000 + 1000);
    const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
    expect(sum(r.byCategory)).toBe(r.total.cents);
    expect(sum(r.byProject)).toBe(r.total.cents);
    expect(r.byCategory).toEqual({ "ICT-003": 13300, "ICT-005": 60000, [UNCATEGORIZED]: 77000 - 3000 - 73300 + 1000 });
    expect(r.byProject["AP_26001"]).toBe(13300);
    expect(r.advanceItems.map((i) => i.itemId)).toEqual(["I2"]);
    expect(r.excludedItems).toEqual([expect.objectContaining({ itemId: "I3", reason: "已退貨", amountCents: 3000 })]);
  });
});
