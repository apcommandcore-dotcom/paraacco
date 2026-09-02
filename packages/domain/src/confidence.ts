// 文件整體 OCR 信心分數計算 —— 對應規格文件缺口清單第 2 點(「OCR 信心分數怎麼算」未定義)、
// Perplexity 技術提案的加權平均建議。
//
// v1 的問題(規格文件原本就標記為缺口):apps/document-worker 直接把 OCR provider 回傳的
// 「整份文件信心分數」原封不動寫進 documents.ocrConfidence,沒有考慮:
//   1. OCR provider 的整體分數通常是「所有偵測到的文字區塊」的平均,包含大量對業務判斷
//      不重要的區塊(例如頁尾的制式條款文字),真正重要的是「必要欄位」(發票號、金額、
//      供應商、日期等)個別的辨識信心。
//   2. 使用者在覆核畫面手動確認/修正過的欄位,或是用 QR Code 解碼取得的欄位,正確性
//      應該視為 100%,不該被原始 OCR 的低信心分數拖累整體分數。
//
// 修正方式:改成「必要欄位的加權平均」——每個欄位依重要性給權重,使用者確認過或 QR 解碼
// 的欄位一律算 100 分,其餘用該欄位各自的 OCR/AI 推論信心分數。

export type ExtractionSource = "ocr" | "qr" | "ai_inference" | "vendor_lookup" | "user_input";

export interface FieldConfidenceInput {
  fieldKey: string;
  /** 該欄位單獨的信心分數 0–100(來自 OCR provider 或 AI 推論),user_input/qr 來源可省略。 */
  confidence?: number;
  /** 是否已由人工在覆核畫面確認或修正過 —— 一律視為 100% 正確。 */
  isUserConfirmed?: boolean;
  extractionSource?: ExtractionSource;
  /** 這個欄位的重要性權重,預設依 fieldKey 查 REQUIRED_FIELD_WEIGHTS,查不到則為 1。 */
  weight?: number;
}

/**
 * 必要欄位權重表 —— 對應規格文件 2.6 節文件必要欄位。金額、發票號、供應商是關聯比對與
 * 財務記錄最關鍵的欄位,權重較高;品牌型號、序號等次要欄位權重較低。
 */
export const REQUIRED_FIELD_WEIGHTS: Record<string, number> = {
  vendorNameRaw: 2,
  invoiceNo: 2,
  amountCents: 2,
  docDate: 1.5,
  orderNo: 1.5,
  serialNo: 1,
  brand: 1,
  model: 1,
};

function clamp0to100(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/** 單一欄位的「有效信心分數」:使用者確認過或 QR 解碼一律視為 100,否則用原始信心分數(缺值視為 0)。 */
function effectiveConfidence(field: FieldConfidenceInput): number {
  if (field.isUserConfirmed) return 100;
  if (field.extractionSource === "qr") return 100;
  return clamp0to100(field.confidence ?? 0);
}

/**
 * 計算文件整體信心分數(0–100),寫入 documents.ocrConfidence。
 * 傳入的 fields 應該只包含這份文件實際擷取到(或應該要有,但缺值也要傳入代表 0 分)的
 * 必要欄位,不要把 document_extracted_fields 裡所有次要/雜項欄位都塞進來稀釋分數。
 */
export function calculateOverallConfidence(fields: FieldConfidenceInput[]): number {
  if (fields.length === 0) return 0;

  let weightedSum = 0;
  let weightTotal = 0;
  for (const field of fields) {
    const weight = field.weight ?? REQUIRED_FIELD_WEIGHTS[field.fieldKey] ?? 1;
    weightedSum += effectiveConfidence(field) * weight;
    weightTotal += weight;
  }

  if (weightTotal === 0) return 0;
  return Math.round((weightedSum / weightTotal) * 100) / 100;
}
