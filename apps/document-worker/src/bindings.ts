// Cloudflare Workers bindings 型別 —— 對應 wrangler.toml。
//
// 重要邊界(見根目錄 README):這個 worker 刻意不掛 D1 binding。所有 D1 讀寫一律透過 API
// Service Binding 呼叫 apps/api 的 /internal/* 端點(見 internal-client.ts),確保寫入路徑
// 統一經過驗證與稽核記錄,跟人類使用者走的 /api/* 共用同一份業務規則實作
// (@paraacco/domain 的 matching/vendor-matching/confidence)。

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
};
