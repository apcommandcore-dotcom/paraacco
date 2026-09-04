// 實際串接的 OCR/欄位擷取供應商:Gemini API(2026-09-04 決策,取代 CloudflareWorkersAiOcrProvider
// 當預設呼叫的供應商 —— 見 CODE_TASK_switch-to-gemini-ocr_20260904.md)。
//
// 換供應商的理由:CloudflareWorkersAiOcrProvider 的 PDF 路徑依賴 unpdf 抽文字層,在
// document-worker 這個 Cloudflare Workers 執行環境下有相容性問題(見
// CODE_REPORT_real-invoice-ocr-bug_20260904.md),真實掃描發票(沒有文字層)完全無法辨識。
// Theo 用瀏覽器端測試 app 拿真實掃描發票測過 Gemini API,完整品項明細都正確辨識。Gemini API
// 原生支援直接吃 PDF 檔案(inline_data.mime_type 填 application/pdf,不用像瀏覽器端測試 app
// 那樣先轉成圖片),比繞道 Cloudflare 視覺模型還要多一道「PDF→圖片」轉檔步驟更直接。
//
// CloudflareWorkersAiOcrProvider 沒有刪除,保留在這個套件裡當備援/之後比較用(比照
// MockOcrProvider 的保留方式),只是不再是預設呼叫的那個(見 apps/document-worker/src/
// workflow.ts 的 createOcrProvider())。
//
// 費用:Gemini API 免費層,只要申請 API Key 的 Google Cloud 專案沒有連結 Cloud Billing
// 帳戶,保證不會被收費。免費層速率限制依模型而定,實際使用量(一天最多幾十份單據)遠低於
// 任何 flash 等級模型的限制。

import type { OcrExtractionResult, OcrProvider, OcrProviderInput } from "./provider";
import { buildExtractionPrompt, parseExtractionResponse } from "./extraction-prompt";
import { arrayBufferToBase64, toExtractionResult, unsupportedResult } from "./shared";

const PROVIDER_NAME = "GeminiOcrProvider";
const DEFAULT_MODEL = "gemini-3.6-flash";
const DEFAULT_BASE_CONFIDENCE = 90;

export interface GeminiOcrProviderOptions {
  apiKey: string;
  /** 2026-09-05 實測時 gemini-2.5-flash 已經對新使用者下架(API 直接回錯誤訊息指名要換
   * gemini-3.6-flash),Google 偶爾會調整可用模型清單,遇到「model not found」/404 類錯誤時,
   * 先查 https://ai.google.dev/gemini-api/docs/models 確認 ID 是否還有效。 */
  model?: string;
  /** 沒有信心分數自報時使用的固定基準值(跟 CloudflareWorkersAiOcrProvider 一樣,是保守的
   * 固定基準值,不是模型自我回報的分數,需要用真實單據測試後再調整)。 */
  baseConfidence?: number;
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

export class GeminiOcrProvider implements OcrProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseConfidence: number;

  constructor(opts: GeminiOcrProviderOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseConfidence = opts.baseConfidence ?? DEFAULT_BASE_CONFIDENCE;
  }

  async extract(input: OcrProviderInput): Promise<OcrExtractionResult> {
    if (input.mimeType !== "application/pdf" && !input.mimeType.startsWith("image/")) {
      return unsupportedResult(input, `不支援的檔案類型:${input.mimeType},需人工輸入`, PROVIDER_NAME);
    }

    const prompt = buildExtractionPrompt();
    const base64 = arrayBufferToBase64(input.fileBytes);

    let res: Response;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [{ text: prompt }, { inline_data: { mime_type: input.mimeType, data: base64 } }],
              },
            ],
            generationConfig: { response_mime_type: "application/json" },
          }),
        },
      );
    } catch (err) {
      return unsupportedResult(input, `Gemini API 呼叫失敗:${err instanceof Error ? err.message : String(err)},需人工輸入`, PROVIDER_NAME);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return unsupportedResult(input, `Gemini API 呼叫失敗(${res.status}):${errText},需人工輸入`, PROVIDER_NAME);
    }

    const json = (await res.json()) as GeminiGenerateContentResponse;
    const raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const parsed = parseExtractionResponse(raw);
    if (!parsed) {
      return unsupportedResult(input, "Gemini 回應無法解析成 JSON,需人工輸入", PROVIDER_NAME);
    }

    return toExtractionResult(parsed, this.baseConfidence, `Gemini(${this.model})`);
  }
}
