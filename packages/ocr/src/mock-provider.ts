// 開發/測試用的假 OCR provider —— 目前尚未選定實際 OCR 供應商(規格文件缺口清單第 1 點),
// 先用這個讓 pipeline 8 個步驟可以完整跑通、寫進 D1、走到覆核畫面。
//
// 刻意不憑空生出看起來像真的供應商名稱/金額/發票號這類業務資料(呼應這個專案「不把假資料
// 當真資料用」的原則,見 packages/db/migrations/seed.sql 的說明)—— 每個欄位的信心分數都是
// 0,唯一的欄位是一個 sourceNote 註明「尚未串接 OCR」,讓文件照樣通過 pipeline,但因為
// 信心值全部是 0、供應商欄位也是空的,vendor-check 會強制送人工覆核,不會被誤判成高信心
// 自動歸檔 —— 在還沒選定真正的 OCR 供應商之前,這是唯一安全的預設行為。
//
// 之後選定實際供應商後,新增一個實作 OcrProvider 介面的 class(例如 GoogleDocumentAiProvider),
// 在 apps/document-worker 換掉這裡的 new MockOcrProvider() 即可,不用動 Workflow 步驟邏輯。

import type { OcrExtractionResult, OcrProvider, OcrProviderInput } from "./provider";

export class MockOcrProvider implements OcrProvider {
  async extract(input: OcrProviderInput): Promise<OcrExtractionResult> {
    return {
      fields: [
        {
          fieldKey: "_ocr_status",
          label: "OCR 狀態",
          value: "尚未串接實際 OCR 供應商,此文件需人工輸入所有欄位",
          confidence: 0,
          extractionSource: "ocr",
          sourceNote: `MockOcrProvider(${input.mimeType}, ${input.fileName})`,
        },
      ],
    };
  }
}
