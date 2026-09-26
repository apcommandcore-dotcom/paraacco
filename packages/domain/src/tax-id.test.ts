import { describe, expect, it } from "vitest";
import { isValidTaxId, normalizeTaxId } from "./tax-id";

describe("isValidTaxId", () => {
  it("這次單據上出現過的真實統編都合法", () => {
    for (const id of ["83018456", "28977199", "24794037", "28976305", "03774909", "38509049", "86382689", "04406559", "24814532"]) {
      expect(isValidTaxId(id), id).toBe(true);
    }
  });
  it("第 7 碼是 7 的特例", () => {
    expect(isValidTaxId("10458575")).toBe(true); // 10458575:Z=29,(29+1)%5=0
  });
  it("格式或檢查碼錯誤", () => {
    expect(isValidTaxId("2897719")).toBe(false); // 少一碼(截圖裡的情況)
    expect(isValidTaxId("28977190")).toBe(false);
    expect(isValidTaxId("abcdefgh")).toBe(false);
  });
  it("去空白、連字號", () => {
    expect(normalizeTaxId("2897 7199")).toBe("28977199");
  });
});
