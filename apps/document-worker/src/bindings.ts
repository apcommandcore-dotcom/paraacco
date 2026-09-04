// Cloudflare Workers bindings 型別 —— 對應 wrangler.toml。
//
// 重要邊界(見根目錄 README):這個 worker 刻意不掛 D1 binding。所有 D1 讀寫一律透過 API
// Service Binding 呼叫 apps/api 的 /internal/* 端點(見 internal-client.ts),確保寫入路徑
// 統一經過驗證與稽核記錄,跟人類使用者走的 /api/* 共用同一份業務規則實作
// (@paraacco/domain 的 matching/vendor-matching/confidence)。
//
// AI:Cloudflare Workers AI binding。CloudflareWorkersAiOcrProvider(@paraacco/ocr)備援用,
// 不是目前預設呼叫的 OCR 供應商,保留 binding 供之後比較/切換用。
//
// GEMINI_API_KEY:實際 OCR/欄位擷取供應商用(2026-09-04 決策,見 @paraacco/ocr 的
// gemini-provider.ts 開頭註解)。用 `wrangler secret put GEMINI_API_KEY` 設定,不寫在
// wrangler.toml 裡——申請時務必用沒有連結 Cloud Billing 帳戶的 Google Cloud 專案,確保免費層
// 保證不收費。

export type DocumentQueueMessage = {
  documentId: string;
  reason: "initial" | "retry";
};

export type DocumentWorkflowParams = {
  documentId: string;
  jobId: string;
  reason: "initial" | "retry";
};

export type Bindings = {
  FILES: R2Bucket;
  /** Service Binding → paraacco-api,呼叫 /internal/* 端點。 */
  API: Fetcher;
  INTERNAL_SERVICE_TOKEN: string;
  DOCUMENT_PROCESSING_WORKFLOW: Workflow<DocumentWorkflowParams>;
  AI: Ai;
  GEMINI_API_KEY: string;
};
