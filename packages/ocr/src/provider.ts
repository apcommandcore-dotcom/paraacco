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
  extractionSource: "ocr" | "qr" | "ai_inference";
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
  invoiceNo?: string;
  orderNo?: string;
  serialNo?: string;
  brand?: string;
  model?: string;
  amountCents?: number;
  currency?: string;
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
