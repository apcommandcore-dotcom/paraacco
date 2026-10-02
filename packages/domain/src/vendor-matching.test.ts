import { describe, expect, it } from "vitest";
import { findVendorByTaxId, requiresForcedReview, resolveVendorTaxId, vendorStatusOf } from "./vendor-matching";

// 2026-09-29 CODE_TASK_vendor-name-from-taxid_20260929.md 第四節測試。
const VENDORS = [
  { id: "vnd-展蝶企業社-56d0", name: "展蝶企業社", taxId: "82066492" },
  { id: "vendor-cht", name: "中華電信股份有限公司", taxId: "81691784" },
  { id: "vendor-nhi", name: "衛生福利部中央健康保險署", taxId: null },
];

describe("resolveVendorTaxId(R-V2 QR 優先)", () => {
  it("82066492 → 展蝶企業社(已建檔),店名不參與", () => {
    const r = resolveVendorTaxId({ qr: "82066492" });
    expect(r).toMatchObject({ taxId: "82066492", source: "qr", note: null });
    const v = findVendorByTaxId(r.taxId, VENDORS);
    expect(v?.name).toBe("展蝶企業社");
    expect(vendorStatusOf(r, v)).toBe("matched");
    expect(requiresForcedReview(v)).toBe(false);
  });

  it("QR 與印字不一致 → 以 QR 為準、notes 有註記", () => {
    const r = resolveVendorTaxId({ qr: "82066492", printed: "81691784" });
    expect(r.taxId).toBe("82066492");
    expect(r.source).toBe("qr");
    expect(r.note).toContain("以 QR 為準");
  });

  it("QR 檢查碼錯誤 → 改用印字並註記", () => {
    const r = resolveVendorTaxId({ qr: "82066493", printed: "82066492" });
    expect(r).toMatchObject({ taxId: "82066492", source: "printed" });
    expect(r.note).toContain("檢查碼錯誤");
  });

  it("只有印字", () => {
    expect(resolveVendorTaxId({ printed: "8206 6492" })).toMatchObject({ taxId: "82066492", source: "printed", note: null });
  });

  it("檢查碼錯誤的統編 → 無法辨識、不比對", () => {
    const r = resolveVendorTaxId({ printed: "28977190" });
    expect(r).toMatchObject({ taxId: null, source: "unreadable", rawInvalid: "28977190" });
    expect(r.note).toContain("統編無法辨識");
    expect(findVendorByTaxId("28977190", VENDORS)).toBeNull();
    expect(vendorStatusOf(r, null)).toBe("taxid_unreadable");
  });

  it("讀不到統編 → 無法辨識", () => {
    expect(resolveVendorTaxId({})).toMatchObject({ taxId: null, source: "unreadable", rawInvalid: null });
  });

  it("舊資料只有 vendorTaxId → 視為印字", () => {
    expect(resolveVendorTaxId({ legacy: "24794037" })).toMatchObject({ taxId: "24794037", source: "printed" });
    expect(resolveVendorTaxId({ legacy: "24794037", legacySource: "qr" })).toMatchObject({ source: "qr" });
  });

  it("未建檔的有效統編 → pending", () => {
    const r = resolveVendorTaxId({ qr: "24794037" });
    const v = findVendorByTaxId(r.taxId, VENDORS);
    expect(v).toBeNull();
    expect(vendorStatusOf(r, v)).toBe("pending");
    expect(requiresForcedReview(v)).toBe(true);
  });

  it("主檔沒有統編的供應商(健保署)不會被任何統編比對到", () => {
    expect(findVendorByTaxId(null, VENDORS)).toBeNull();
  });
});
