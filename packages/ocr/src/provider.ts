// OCR provider 抽象介面 —— 對應規格文件缺口清單第 1 點(尚未選定 OCR 供應商)。
//
// document-worker 的 Workflow 只依賴這個介面,不直接綁死任何特定廠商 SDK,之後選定
// 實際供應商(例如 Google Document AI、Azure Document Intelligence、Mistral OCR 等)時,
// 只需要新增一個實作這個介面的 class,不用動 Workflow 步驟邏輯。

export interface OcrExtractedField {
  fieldKey: string;
  label: string;
  value?: string;
  normalizedValue?: string;
  /** 這個欄位單獨的辨識信心分數 0–100,供 @paraacco/domain 的 calculateOverallConfidence() 使用。 */
  confidence?: number;
  extractionSource: "ocr" | "qr" | "ai_inference" | "user_input";
  sourceNote?: string;
  pageNumber?: number;
  bboxJson?: string;
}

export interface OcrExtractionResult {
  fields: OcrExtractedField[];
  /** 供 vendor-check 用的原始供應商資訊。 */
  vendorNameRaw?: string;
  vendorTaxId?: string;
  vendorAliasCandidates?: string[];
  /** 供 classify 用的文件層級摘要欄位(對應 documents 表促升的直欄)。 */
  docTypeCode?: string;
  docDate?: string;
  /** 單據/發票開立日期,跟 docDate(含「繳費期限優先」混合語意)分開,供依發票日期排序
   * 使用(2026-09-18,見 CODE_TASK_document-fields-additions_20260918.md)。 */
  invoiceDate?: string;
  invoiceNo?: string;
  orderNo?: string;
  serialNo?: string;
  brand?: string;
  model?: string;
  /** 品項/服務內容一句話描述,供 classify 用來填 documents.display_name 的預設值
   * (只在該欄位還是 null 時,2026-09-18)。 */
  itemName?: string;
  amountCents?: number;
  currency?: string;
  // --- 2026-09-13 財務文件自動分類新增,供 classify 用(見 @paraacco/domain 的
  // classifyDocument())---
  scope?: string;
  financeDocType?: string;
  counterparty?: string;
  classificationConfidence?: "high" | "medium" | "low";
  notes?: string;
}

export interface OcrProviderInput {
  documentId: string;
  fileBytes: ArrayBuffer;
  mimeType: string;
  fileName: string;
}

export interface OcrProvider {
  extract(input: OcrProviderInput): Promise<OcrExtractionResult>;
}
