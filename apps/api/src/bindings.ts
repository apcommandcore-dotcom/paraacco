// Cloudflare Workers bindings 型別 —— 對應 wrangler.toml。
//
// DOCUMENT_QUEUE:文件上傳/需要重新處理時,把 documentId 丟進佇列,由 apps/document-worker
// 的 queue consumer 接手啟動 Workflow(見範圍決策:OCR pipeline 採 Queues + Workflows)。
// INTERNAL_SERVICE_TOKEN:document-worker 透過 Service Binding 呼叫這裡的 /internal/* 端點時
// 帶的共用密鑰,取代給人類用的 Cloudflare Access 驗證(Service Binding 是 Worker 對 Worker
// 的直接呼叫,不會經過 Access,所以需要自己的一層驗證,見 middleware/internal-auth.ts)。

export type DocumentQueueMessage = {
  documentId: string;
  /** 'initial' = 收件匣新上傳;'retry' = pipeline 失敗後重新排入。 */
  reason: "initial" | "retry";
};

export type Bindings = {
  DB: D1Database;
  FILES: R2Bucket;
  DOCUMENT_QUEUE: Queue<DocumentQueueMessage>;
  INTERNAL_SERVICE_TOKEN: string;
};
