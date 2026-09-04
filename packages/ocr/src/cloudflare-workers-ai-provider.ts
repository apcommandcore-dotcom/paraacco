// 備援 OCR/欄位擷取供應商:Cloudflare Workers AI(2026-09-03 選定,2026-09-04 起不再是預設
// 呼叫的供應商,見 @paraacco/ocr 的 gemini-provider.ts —— PDF 文字層擷取在 Cloudflare Workers
// 環境下有相容性問題,真實掃描發票完全無法辨識,詳見 CODE_REPORT_real-invoice-ocr-bug_20260904.md)。
//
// 保留當備援/之後比較用(比照 MockOcrProvider 的保留方式)。
//
// 已知限制(務必讓下一個接手的人看到,不要覆蓋這段註解):
//   - **只支援影像輸入**(手機拍照上傳的收據 jpg/png/webp)。PDF 路徑已經拿掉——原本靠 unpdf
//     抽 PDF 內嵌文字層,那個相依套件在這個 Cloudflare Workers 環境下會直接掛掉(見上面連結
//     的報告),2026-09-05 清理時把 unpdf 依賴、pdf-text.ts 一併移除,PDF 這條路徑目前完全
//     沒有實作。如果之後要重新啟用這個 provider 當 PDF 備援,要另外解決 PDF 讀取問題(選項:
//     改用 Gemini 那種直接吃檔案原始位元組的方式、或找別的 Workers 相容的 PDF 文字層擷取
//     套件),不要重新導入 unpdf。
//   - 這裡的信心分數是「保守的固定基準值」,不是模型自我回報的分數(LLM 自報信心不可靠,
//     業界共識是不能直接拿來當真正的信心分數用)。
//   - 模型 ID 是 2026-09 當下 Cloudflare Workers AI 目錄裡可用的版本,Cloudflare 偶爾會
//     調整可用模型清單,部署後若遇到「model not found」類錯誤,先查
//     https://developers.cloudflare.com/workers-ai/models/ 確認 ID 是否還有效、有無更新的
//     視覺模型可換。

import type { OcrExtractionResult, OcrProvider, OcrProviderInput } from "./provider";
import { buildExtractionPrompt, parseExtractionResponse } from "./extraction-prompt";
import { arrayBufferToBase64, toExtractionResult, unsupportedResult } from "./shared";

const PROVIDER_NAME = "CloudflareWorkersAiOcrProvider";

/**
 * Workers AI binding 的最小介面 —— 刻意不直接依賴 @cloudflare/workers-types 的 Ai 型別,
 * 讓 @paraacco/ocr 不用因為這個 provider 就多背一個只有在 Workers 環境才有意義的型別依賴。
 * apps/document-worker 傳進來的 env.AI(型別是 workers-types 的 Ai)結構上相容這個介面。
 */
export interface WorkersAiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export interface CloudflareWorkersAiProviderOptions {
  ai: WorkersAiBinding;
  /** 視覺模型(影像路徑用,目前唯一支援的路徑)。 */
  visionModel?: string;
  /** 沒有信心分數自報時使用的固定基準值(見檔案開頭註解:待真實資料測試後調整)。 */
  baseConfidence?: { visionPath: number };
}

const DEFAULT_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

export class CloudflareWorkersAiOcrProvider implements OcrProvider {
  private readonly ai: WorkersAiBinding;
  private readonly visionModel: string;
  private readonly baseConfidence: { visionPath: number };

  constructor(opts: CloudflareWorkersAiProviderOptions) {
    this.ai = opts.ai;
    this.visionModel = opts.visionModel ?? DEFAULT_VISION_MODEL;
    this.baseConfidence = opts.baseConfidence ?? { visionPath: 60 };
  }

  async extract(input: OcrProviderInput): Promise<OcrExtractionResult> {
    if (input.mimeType.startsWith("image/")) {
      return this.extractFromImage(input);
    }
    return unsupportedResult(
      input,
      `不支援的檔案類型:${input.mimeType}(這個備援 provider 只支援影像,PDF 請改用預設的 GeminiOcrProvider),需人工輸入`,
      PROVIDER_NAME,
    );
  }

  private async extractFromImage(input: OcrProviderInput): Promise<OcrExtractionResult> {
    const base64 = arrayBufferToBase64(input.fileBytes);
    const prompt = buildExtractionPrompt();
    const raw = await this.ai.run(this.visionModel, {
      messages: [
        { role: "system", content: "你是台灣會計單據欄位擷取助手,只輸出 JSON,不要多餘說明文字。" },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${input.mimeType};base64,${base64}` } },
          ],
        },
      ],
    });

    const parsed = parseExtractionResponse(extractResponseText(raw));
    if (!parsed) return unsupportedResult(input, "模型回應無法解析成 JSON,需人工輸入", PROVIDER_NAME);

    return toExtractionResult(parsed, this.baseConfidence.visionPath, `${this.visionModel}(影像辨識)`);
  }
}

// --- 輔助函式(純邏輯,方便單元測試,不需要真的呼叫 Workers AI) ---

export function extractResponseText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "response" in raw) {
    const response = (raw as { response?: unknown }).response;
    if (typeof response === "string") return response;
  }
  return JSON.stringify(raw);
}
