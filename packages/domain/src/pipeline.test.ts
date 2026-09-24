// 關鍵路徑測試:isExternalExtractionField() —— apps/document-worker/src/workflow.ts 的
// stage-3-ocr 用這個函式判斷「要不要跳過 Gemini」,這裡守的就是實際造成過事故的那段邏輯:
//
//   CODE_REPORT_batch-ingest-no-ocr-207docs-root-cause_20260922.md:原本只看
//   extractionSource === 'user_input',沒排除 ingest_channel 這種系統標記欄位,導致 207 筆
//   批次進件文件全部被誤判成「已經有人工擷取結果」而靜默跳過 Gemini。
//
//   2026-09-23 修正(見 CODE_REPORT_extraction-writeback-api-phase2-proposals_20260923.md
//   提案 1):外部寫回一樣合法地標 extractionSource='ai_inference'(跟 pipeline 自己跑出來的
//   結果同一個值),只能靠 sourceNote 前綴區分,不能只看 extractionSource。
//
// 不測 workflow.ts 本身(Cloudflare Workflow 的 step.do() 需要真的 WorkflowStep 執行環境,
// 這個 repo 目前沒有 Workflows 的測試 harness,新建一套的成本跟這裡要守的邏輯不成比例)——
// isExternalExtractionField() 是 workflow.ts 唯一用來做這個判斷的地方,測這個函式就是測
// 同一段邏輯。

import { describe, expect, it } from "vitest";
import { EXTERNAL_EXTRACTION_SOURCE_NOTE_PREFIX, REAL_EXTRACTION_FIELD_KEYS, isExternalExtractionField } from "./pipeline";

describe("isExternalExtractionField", () => {
  it("ingest_channel 這類系統標記欄位,即使標 user_input 也不算(207 筆事故的根因)", () => {
    expect(
      isExternalExtractionField({ fieldKey: "ingest_channel", extractionSource: "user_input" }),
    ).toBe(false);
  });

  it("白名單內的欄位標 user_input 才算", () => {
    expect(
      isExternalExtractionField({ fieldKey: "vendorNameRaw", extractionSource: "user_input" }),
    ).toBe(true);
  });

  it("白名單內的欄位標 ai_inference,但 sourceNote 沒有外部擷取前綴 —— 不算(pipeline 自己跑出來的結果,不能被當成已經跳過)", () => {
    expect(
      isExternalExtractionField({ fieldKey: "amountCents", extractionSource: "ai_inference", sourceNote: "Gemini(gemini-2.0-flash)" }),
    ).toBe(false);
    expect(
      isExternalExtractionField({ fieldKey: "amountCents", extractionSource: "ai_inference", sourceNote: null }),
    ).toBe(false);
    expect(
      isExternalExtractionField({ fieldKey: "amountCents", extractionSource: "ai_inference" }),
    ).toBe(false);
  });

  it("白名單內的欄位標 ai_inference,sourceNote 有外部擷取前綴 —— 算(POST /api/extraction-writeback/documents/:id 寫回的結果)", () => {
    expect(
      isExternalExtractionField({
        fieldKey: "amountCents",
        extractionSource: "ai_inference",
        sourceNote: `${EXTERNAL_EXTRACTION_SOURCE_NOTE_PREFIX}Claude 對話判讀`,
      }),
    ).toBe(true);
  });

  it("不在白名單內的欄位,不管 extractionSource/sourceNote 是什麼都不算", () => {
    expect(
      isExternalExtractionField({
        fieldKey: "some_random_key",
        extractionSource: "ai_inference",
        sourceNote: `${EXTERNAL_EXTRACTION_SOURCE_NOTE_PREFIX}Claude 對話判讀`,
      }),
    ).toBe(false);
    expect(isExternalExtractionField({ fieldKey: "some_random_key", extractionSource: "user_input" })).toBe(false);
  });

  it("ocr/qr 來源不算(那是 pipeline 自己的 OCR/QR 結果,不是人工/外部提供的)", () => {
    expect(isExternalExtractionField({ fieldKey: "invoiceNo", extractionSource: "ocr" })).toBe(false);
    expect(isExternalExtractionField({ fieldKey: "invoiceNo", extractionSource: "qr" })).toBe(false);
  });

  it("REAL_EXTRACTION_FIELD_KEYS 白名單包含寫回端點會 dual-write 的 6 個 documents 直欄鍵,不含 ingest_channel", () => {
    for (const key of ["invoiceNo", "invoiceDate", "vendorNameRaw", "brand", "serialNo", "amountCents"]) {
      expect(REAL_EXTRACTION_FIELD_KEYS.has(key)).toBe(true);
    }
    expect(REAL_EXTRACTION_FIELD_KEYS.has("ingest_channel")).toBe(false);
  });
});
