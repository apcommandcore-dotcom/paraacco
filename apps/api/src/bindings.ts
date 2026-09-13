// Cloudflare Workers bindings 型別 —— 對應 wrangler.toml。
//
// DOCUMENT_QUEUE:文件上傳/需要重新處理時,把 documentId 丟進佇列,由 apps/document-worker
// 的 queue consumer 接手啟動 Workflow(見範圍決策:OCR pipeline 採 Queues + Workflows)。
// INTERNAL_SERVICE_TOKEN:document-worker 透過 Service Binding 呼叫這裡的 /internal/* 端點時
// 帶的共用密鑰,取代給人類用的 Cloudflare Access 驗證(Service Binding 是 Worker 對 Worker
// 的直接呼叫,不會經過 Access,所以需要自己的一層驗證,見 middleware/internal-auth.ts)。
//
// R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ACCOUNT_ID:2026-09-06 補上,給
// routes/uploads.ts 簽發 R2 預簽 URL 用(見該檔案開頭註解)。這三個不是 R2 binding 本身
// 能提供的東西——預簽 URL 是 S3 相容 API 的簽章機制,要用 R2 的 S3 API token(不是
// Cloudflare 帳號的 API Token),申請路徑:Cloudflare Dashboard → R2 → Manage R2 API
// Tokens → Create API Token(Object Read & Write 權限即可,不用 Admin)。設定:
//   npx wrangler secret put R2_ACCESS_KEY_ID
//   npx wrangler secret put R2_SECRET_ACCESS_KEY
//   npx wrangler secret put R2_ACCOUNT_ID   (Cloudflare 帳號 ID,不是 API Token 本身)
//
// LOCAL_SCANNER_TOKEN:2026-09-13 補上,給 routes/batch-import.ts 用(每日批次進件排程腳本
// 呼叫,見該檔案開頭註解)。跟 INTERNAL_SERVICE_TOKEN 故意分開設一組獨立的密鑰,不共用——
// 排程腳本跑在本機/NAS 環境,外洩風險跟 document-worker 的 Service Binding 不是同一個等級,
// 分開設定可以限制外洩時的影響範圍(只能打這一條批次進件端點,不能冒充 document-worker)。
// 設定:
//   npx wrangler secret put LOCAL_SCANNER_TOKEN

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
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ACCOUNT_ID: string;
  LOCAL_SCANNER_TOKEN: string;
};
