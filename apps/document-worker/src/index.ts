// paraacco-document-worker —— Cloudflare Queue consumer + Workflow entrypoint(見範圍決策:
// 現在就導入 Queues + Workflows)。
//
// 重要邊界:這個 worker 不掛 D1 binding,所有寫入(OCR 結果、文件狀態更新、job/event 記錄)
// 一律呼叫 apps/api 的 /internal/* 端點(見 internal-client.ts、routes/internal/ 於
// apps/api),確保寫入路徑有統一的驗證與稽核記錄。
//
// 冪等性(Cloudflare Queues 是 at-least-once,同一則訊息可能重複投遞):每則訊息第一件事
// 是呼叫 /internal/jobs/claim,用 queue message id 當去重鍵,claim 不到就直接 ack 掉,
// 不重複啟動 Workflow 實例。

import { DocumentProcessingWorkflow } from "./workflow";
import { callInternal } from "./internal-client";
import type { Bindings, DocumentQueueMessage } from "./bindings";

interface ClaimResponse {
  claimed: boolean;
  reason?: string;
  job: { id: string };
}

export default {
  async fetch(): Promise<Response> {
    return new Response("paraacco-document-worker: queue consumer, no HTTP surface", { status: 404 });
  },

  async queue(batch: MessageBatch<DocumentQueueMessage>, env: Bindings): Promise<void> {
    for (const message of batch.messages) {
      try {
        const claim = await callInternal<ClaimResponse>(env, "POST", "/internal/jobs/claim", {
          documentId: message.body.documentId,
          queueMessageId: message.id,
          maxAttempts: 5,
        });

        if (!claim.claimed) {
          // 重複投遞,或這份文件已經有其他 job 在跑 —— 直接 ack,不重複啟動 Workflow。
          message.ack();
          continue;
        }

        const instance = await env.DOCUMENT_PROCESSING_WORKFLOW.create({
          id: claim.job.id,
          params: { documentId: message.body.documentId, jobId: claim.job.id, reason: message.body.reason },
        });

        await callInternal(env, "POST", `/internal/jobs/${claim.job.id}`, {
          workflowInstanceId: instance.id,
        });

        message.ack();
      } catch (err) {
        // claim/Workflow 建立本身失敗(不是 pipeline 內部步驟失敗,那個由 workflow.ts 自己
        // 處理並落地成 documents.status='failed')—— 讓 Cloudflare Queues 依訊息重試設定
        // 重新投遞這則訊息。
        console.error("document-worker queue consumer error", err);
        message.retry();
      }
    }
  },
};

export { DocumentProcessingWorkflow };
