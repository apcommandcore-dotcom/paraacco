// @paraacco/ocr
// OCR provider 抽象介面,與三個實作:
//   - MockOcrProvider:開發/測試佔位,尚未選定供應商前用這個確保 pipeline 8 步驟能跑通。
//   - CloudflareWorkersAiOcrProvider:2026-09-03 選定、2026-09-04 已不再是預設呼叫的供應商
//     (PDF 文字層擷取在 Cloudflare Workers 環境下有相容性問題,已拿掉 PDF 路徑,只剩影像),
//     保留當備援/之後比較用。
//   - GeminiOcrProvider:2026-09-04 決策後預設呼叫的供應商(見該檔案開頭註解的選型理由),
//     PDF/影像都直接讀原始檔案,不需要另外的文字層擷取步驟。

export * from "./provider";
export * from "./mock-provider";
export * from "./extraction-prompt";
export * from "./shared";
export * from "./cloudflare-workers-ai-provider";
export * from "./gemini-provider";
