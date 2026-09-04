// OCR provider 之間共用的純邏輯 —— base64 編碼、失敗時的低信心佔位結果、把
// ExtractedDocFields(模型輸出的頂層摘要)攤平成 OcrExtractionResult 的欄位列表。
// CloudflareWorkersAiOcrProvider、GeminiOcrProvider 都用同一份,避免兩邊各寫一份邏輯
// 不小心兜出不同的結果形狀。

import type { OcrExtractedField, OcrExtractionResult, OcrProviderInput } from "./provider";
import type { ExtractedDocFields } from "./extraction-prompt";

// 手刻 base64 編碼,不依賴 `btoa`(Workers/瀏覽器有這個全域函式,但 packages/ocr 刻意保持
// runtime-agnostic,不為了這一個函式就把 @cloudflare/workers-types 拉進來當型別依賴)。
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;

    result += BASE64_CHARS[b0 >> 2];
    result += BASE64_CHARS[((b0 & 0x03) << 4) | (b1 !== undefined ? b1 >> 4 : 0)];
    result += b1 !== undefined ? BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 !== undefined ? b2 >> 6 : 0)] : "=";
    result += b2 !== undefined ? BASE64_CHARS[b2 & 0x3f] : "=";
  }
  return result;
}

export function unsupportedResult(input: OcrProviderInput, note: string, providerName: string): OcrExtractionResult {
  return {
    fields: [
      {
        fieldKey: "_ocr_status",
        label: "OCR 狀態",
        value: note,
        confidence: 0,
        extractionSource: "ai_inference",
        sourceNote: `${providerName}(${input.mimeType}, ${input.fileName})`,
      },
    ],
  };
}

export function toExtractionResult(parsed: ExtractedDocFields, baseConfidence: number, sourceNote: string): OcrExtractionResult {
  const fields: OcrExtractedField[] = [];
  const push = (fieldKey: string, label: string, value: string | undefined) => {
    if (!value) return;
    fields.push({ fieldKey, label, value, confidence: baseConfidence, extractionSource: "ai_inference", sourceNote });
  };

  push("vendorNameRaw", "供應商", parsed.vendorNameRaw);
  push("vendorTaxId", "統一編號", parsed.vendorTaxId);
  push("docDate", "日期", parsed.docDate);
  push("invoiceNo", "發票號碼", parsed.invoiceNo);
  push("orderNo", "訂單號碼", parsed.orderNo);
  push("serialNo", "序號/IMEI", parsed.serialNo);
  push("brand", "品牌", parsed.brand);
  push("model", "型號", parsed.model);

  const amountCents = parsed.amount !== undefined ? Math.round(parsed.amount * 100) : undefined;
  if (amountCents !== undefined) {
    fields.push({
      fieldKey: "amountCents",
      label: "金額",
      value: String(amountCents),
      confidence: baseConfidence,
      extractionSource: "ai_inference",
      sourceNote,
    });
  }

  return {
    fields,
    vendorNameRaw: parsed.vendorNameRaw,
    vendorTaxId: parsed.vendorTaxId,
    docTypeCode: parsed.docTypeCode,
    docDate: parsed.docDate,
    invoiceNo: parsed.invoiceNo,
    orderNo: parsed.orderNo,
    serialNo: parsed.serialNo,
    brand: parsed.brand,
    model: parsed.model,
    amountCents,
    currency: parsed.currency ?? "TWD",
  };
}
