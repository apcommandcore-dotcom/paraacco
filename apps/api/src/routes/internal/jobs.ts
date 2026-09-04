// /internal/jobs/* —— document_processing_jobs / document_processing_events 的寫入端點,
// 給 apps/document-worker 的 queue consumer 與 Workflow 步驟用。
//
// 冪等性(見範圍決策:Cloudflare Queues 是 at-least-once,同一則訊息可能被重複投遞):
// consumer 收到訊息後第一件事一定是呼叫 POST /internal/jobs/claim,用 queueMessageId 當
// 去重鍵 —— 如果這個 queueMessageId 已經有對應的 job(代表是重複投遞,可能是前一次處理
// 逾時但其實已經在跑了),或是這份文件已經有其他 job 正在 queued/running,一律回傳
// claimed:false,consumer 直接 ack 掉這則訊息、不重複啟動 Workflow。

import { Hono } from "hono";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { createDb, documentProcessingEvents, documentProcessingJobs } from "@paraacco/db";
import type { Bindings } from "../../bindings";

export const internalJobsRoute = new Hono<{ Bindings: Bindings }>();

internalJobsRoute.post("/claim", async (c) => {
  const body = await c.req.json<{ documentId: string; queueMessageId: string; maxAttempts?: number }>();
  const db = createDb(c.env.DB);

  // 已經被這一則 queue message 認領過(Queues at-least-once 重複投遞)—— 直接回傳同一個 job,
  // 不重複處理。
  const [dup] = await db
    .select()
    .from(documentProcessingJobs)
    .where(eq(documentProcessingJobs.queueMessageId, body.queueMessageId))
    .limit(1);
  if (dup) return c.json({ claimed: false, reason: "duplicate_message", job: dup });

  // 2026-09-04 修正:「已經在跑」只能看真正被某則 queue message 認領過的 job
  // (queueMessageId 不是 null)。POST /api/documents 會先插入一筆 status='queued'、
  // queueMessageId=null 的「佔位 job」讓前端立刻有東西可顯示(見 routes/documents.ts)——
  // 修正前這裡沒排除 queueMessageId IS NULL,佔位 job 自己就符合「documentId 相同、
  // status 落在 queued/running」的條件,claim() 一律把它判成 already_in_flight,回傳
  // claimed:false,consumer 直接 ack 掉、從不建立 Workflow 實例,pipeline 永遠卡在
  // stage 1 / queued(workflow_instance_id、queue_message_id 都是 null)。
  const inFlight = await db
    .select()
    .from(documentProcessingJobs)
    .where(
      and(
        eq(documentProcessingJobs.documentId, body.documentId),
        inArray(documentProcessingJobs.status, ["queued", "running"]),
        isNotNull(documentProcessingJobs.queueMessageId),
      ),
    );
  if (inFlight.length) return c.json({ claimed: false, reason: "already_in_flight", job: inFlight[0] });

  const now = new Date().toISOString();

  // 優先認領 POST /api/documents 建立的佔位 job(同 documentId、queueMessageId 還是
  // null),而不是另外插入一筆新的 job row —— 這樣 GET /api/documents/:id 從頭到尾看到
  // 的都是同一個 job id,不會出現兩筆 job 對應同一份文件。
  const [placeholder] = await db
    .select()
    .from(documentProcessingJobs)
    .where(
      and(
        eq(documentProcessingJobs.documentId, body.documentId),
        eq(documentProcessingJobs.status, "queued"),
      ),
    )
    .limit(1);

  if (placeholder) {
    await db
      .update(documentProcessingJobs)
      .set({
        queueMessageId: body.queueMessageId,
        status: "running",
        maxAttempts: body.maxAttempts ?? 5,
        lockedAt: now,
        startedAt: now,
        updatedAt: now,
      })
      .where(eq(documentProcessingJobs.id, placeholder.id));

    const [job] = await db.select().from(documentProcessingJobs).where(eq(documentProcessingJobs.id, placeholder.id)).limit(1);
    return c.json({ claimed: true, job });
  }

  const id = crypto.randomUUID();
  await db.insert(documentProcessingJobs).values({
    id,
    documentId: body.documentId,
    queueMessageId: body.queueMessageId,
    currentStage: 1,
    stageKey: "queued",
    status: "running",
    maxAttempts: body.maxAttempts ?? 5,
    lockedAt: now,
    startedAt: now,
  });

  const [job] = await db.select().from(documentProcessingJobs).where(eq(documentProcessingJobs.id, id)).limit(1);
  return c.json({ claimed: true, job });
});

// Workflow 建立實例後回填真正的 workflowInstanceId,以及後續每個 step.do() 完成時更新進度。
internalJobsRoute.post("/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const body = await c.req.json<{
    workflowInstanceId?: string;
    currentStage?: number;
    stageKey?: string;
    status?: string;
    attemptCount?: number;
    errorCode?: string | null;
    errorMessage?: string | null;
    nextRetryAt?: string | null;
    completedAt?: string;
  }>();

  const db = createDb(c.env.DB);
  await db
    .update(documentProcessingJobs)
    .set({ ...body, updatedAt: new Date().toISOString() })
    .where(eq(documentProcessingJobs.id, jobId));

  return c.json({ ok: true });
});

internalJobsRoute.post("/:jobId/events", async (c) => {
  const jobId = c.req.param("jobId");
  const body = await c.req.json<{
    stageNumber: number;
    stageKey: string;
    eventType: string;
    detailJson?: string;
  }>();

  const db = createDb(c.env.DB);
  await db.insert(documentProcessingEvents).values({
    jobId,
    stageNumber: body.stageNumber,
    stageKey: body.stageKey,
    eventType: body.eventType,
    detailJson: body.detailJson ?? null,
  });

  return c.json({ ok: true });
});
