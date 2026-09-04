// 文件(人類使用者端)—— 規格 2.5、2.9、3.5(收件匣＋待覆核工作台)。
//
// v2 架構邊界(範圍決策:OCR pipeline 改用 Cloudflare Queues + Workflows):這支路由只處理
// 「人類使用者」看得到、按得到的操作(收件匣上傳登記、待覆核畫面讀取候選/確認關聯/標記狀態)。
// document-worker 的 Workflow 步驟一律呼叫 /internal/* 端點(見 routes/internal/),不是
// 這支路由 —— 兩邊分開是因為驗證方式完全不同(人類走 Cloudflare Access,Workflow 走
// Service Binding + 共用密鑰)。

import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  activityLog,
  createDb,
  documentAssetLinks,
  documentExtractedFields,
  documentFiles,
  documentProcessingJobs,
  documentPurchaseLinks,
  documents,
  nextId,
  relationCandidates,
  syncDocumentFts,
} from "@paraacco/db";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";

export const documentsRoute = new Hono<{ Bindings: Bindings }>();

documentsRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const status = c.req.query("status");
  const rows = status
    ? await db.select().from(documents).where(eq(documents.status, status)).orderBy(desc(documents.createdAt))
    : await db.select().from(documents).orderBy(desc(documents.createdAt));

  // 收件匣畫面要顯示 pipeline 進度(8 步驟簡化版:current_stage/stage_key)——一份文件
  // 可能因為 retry 累積多筆 job(見 CODE_REPORT_queue-consumer-fix-retest_20260904.md 的
  // 副作用發現),這裡只取每份文件最新建立的那一筆。
  const jobs = rows.length
    ? await db.select().from(documentProcessingJobs).where(inArray(documentProcessingJobs.documentId, rows.map((r) => r.id)))
    : [];
  const latestJobByDoc = new Map<string, (typeof jobs)[number]>();
  for (const job of jobs) {
    const existing = latestJobByDoc.get(job.documentId);
    if (!existing || job.createdAt > existing.createdAt) latestJobByDoc.set(job.documentId, job);
  }

  return c.json({
    documents: rows.map((doc) => ({ ...doc, processingJob: latestJobByDoc.get(doc.id) ?? null })),
  });
});

documentsRoute.get("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const [doc] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  if (!doc) return c.json({ error: "not_found" }, 404);

  const [fields, files, purchaseLinks, assetLinks, jobs] = await Promise.all([
    db.select().from(documentExtractedFields).where(eq(documentExtractedFields.documentId, id)).orderBy(documentExtractedFields.sortOrder),
    db.select().from(documentFiles).where(eq(documentFiles.documentId, id)),
    db.select().from(documentPurchaseLinks).where(eq(documentPurchaseLinks.documentId, id)),
    db.select().from(documentAssetLinks).where(eq(documentAssetLinks.documentId, id)),
    db.select().from(documentProcessingJobs).where(eq(documentProcessingJobs.documentId, id)).orderBy(desc(documentProcessingJobs.createdAt)),
  ]);

  return c.json({ document: doc, fields, files, purchaseLinks, assetLinks, processingJob: jobs[0] ?? null });
});

// 待覆核工作台中欄要顯示原始檔案(PDF/圖片)——直接把 R2 物件內容串流回來,不给前端另外處理
// R2 存取權限(bucket 本身不公開)。預設拿目前生效的 original 檔案,也可以用 ?kind= 指定其他
// kind(例如之後有 normalized_pdf)。
documentsRoute.get("/:id/file", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const kind = c.req.query("kind") ?? "original";

  const [file] = await db
    .select()
    .from(documentFiles)
    .where(and(eq(documentFiles.documentId, id), eq(documentFiles.kind, kind), eq(documentFiles.isCurrent, true)))
    .limit(1);
  if (!file) return c.json({ error: "not_found" }, 404);

  const obj = await c.env.FILES.get(file.r2Key);
  if (!obj) return c.json({ error: "file_missing_in_r2" }, 404);

  return new Response(obj.body, {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Disposition": `inline; filename="${encodeURIComponent(file.originalFileName)}"`,
      "Cache-Control": "private, max-age=300",
    },
  });
});

// 收件匣建立草稿紀錄 —— 檔案本身已由前端直接 PUT 到 R2 預簽 URL(kind='original'),這裡登記
// documents + document_files metadata,開一個 processing job 佔位,並把 documentId 丟進
// DOCUMENT_QUEUE 讓 document-worker 接手處理(見範圍決策:Queues + Workflows)。
documentsRoute.post("/", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{
    ownership: string;
    fileName: string;
    mimeType: string;
    byteSize: number;
    r2Key: string;
    sha256?: string;
    source: string; // 'web_upload' | 'mobile_scan' | 'email_forward' | 'api_import'
    // 人工 OCR(md 交接)接回 pipeline 用 —— 有帶的話,extractionSource 一律由伺服器端強制
    // 設成 'user_input',不採信 client 傳來的值,避免有人假造成看起來像自動 OCR 的高信心結果
    // (見 CODE_TASK_manual-ocr-pipeline-integration_20260904.md)。
    extractedFields?: Array<{
      fieldKey: string;
      label: string;
      value?: string;
      confidence?: number;
    }>;
  }>();

  const db = createDb(c.env.DB);
  const year = new Date().getFullYear();
  const id = await nextId(db, "DOC", year);

  await db.insert(documents).values({
    id,
    ownership: body.ownership,
    source: body.source,
    status: "queued",
    createdByMemberId: auth.memberId,
  });

  await db.insert(documentFiles).values({
    documentId: id,
    kind: "original",
    r2Key: body.r2Key,
    originalFileName: body.fileName,
    mimeType: body.mimeType,
    byteSize: body.byteSize,
    sha256: body.sha256 ?? null,
  });

  const jobId = crypto.randomUUID();
  await db.insert(documentProcessingJobs).values({
    id: jobId,
    documentId: id,
    currentStage: 1,
    stageKey: "queued",
    status: "queued",
  });

  if (body.extractedFields?.length) {
    await db.insert(documentExtractedFields).values(
      body.extractedFields.map((f, i) => ({
        documentId: id,
        fieldKey: f.fieldKey,
        label: f.label,
        value: f.value ?? null,
        confidence: f.confidence ?? null,
        extractionSource: "user_input",
        sortOrder: i,
      })),
    );
    await syncDocumentFts(db, id);
  }

  await db.insert(activityLog).values({
    entityType: "document",
    entityId: id,
    kind: "import",
    text: `新文件匯入:${body.fileName}`,
    actorMemberId: auth.memberId,
  });

  await c.env.DOCUMENT_QUEUE.send({ documentId: id, reason: "initial" });

  return c.json({ ok: true, id }, 201);
});

// 待覆核畫面右欄「關聯候選」—— 讀取 pipeline 第 6 步(matching)已經算好、落地存在
// relation_candidates 的結果(不是即時運算,見 domain/matching.ts 與 routes/internal/documents.ts
// 的 compute-candidates)。
documentsRoute.get("/:id/candidates", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const rows = await db
    .select()
    .from(relationCandidates)
    .where(and(eq(relationCandidates.documentId, id), eq(relationCandidates.decision, "pending")))
    .orderBy(desc(relationCandidates.score));

  return c.json({
    candidates: rows.map((r) => ({ ...r, reasons: JSON.parse(r.reasonsJson) as unknown[] })),
  });
});

// 待覆核畫面底部「連結既有購買案／資產」(人工手動選擇,linkedBy='manual')。
documentsRoute.post("/:id/link", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const id = c.req.param("id");
  const body = await c.req.json<{
    targetType: "purchase" | "asset";
    targetId: string;
    relationKind?: string;
    /** 若是從候選清單挑選,帶對應的 relation_candidates.id,連動把該筆標成 accepted。 */
    candidateId?: number;
  }>();
  const db = createDb(c.env.DB);
  const now = new Date().toISOString();

  if (body.targetType === "purchase") {
    await db.insert(documentPurchaseLinks).values({
      documentId: id,
      purchaseId: body.targetId,
      relationKind: body.relationKind ?? "primary",
      linkedBy: "manual",
      createdByMemberId: auth.memberId,
    });
  } else {
    await db.insert(documentAssetLinks).values({
      documentId: id,
      assetId: body.targetId,
      relationKind: body.relationKind ?? "supporting",
      linkedBy: "manual",
      createdByMemberId: auth.memberId,
    });
  }

  // 這份文件其餘還在 pending 的候選一律標成 superseded(已經人工決定關聯到哪一個了,
  // 避免待覆核清單留著過期候選)。挑選的那一筆(若有帶 candidateId)標成 accepted。
  const pendingCandidates = await db
    .select()
    .from(relationCandidates)
    .where(and(eq(relationCandidates.documentId, id), eq(relationCandidates.decision, "pending")));
  for (const cand of pendingCandidates) {
    await db
      .update(relationCandidates)
      .set({
        decision: body.candidateId === cand.id ? "accepted" : "superseded",
        decidedAt: now,
        decidedByMemberId: auth.memberId,
      })
      .where(eq(relationCandidates.id, cand.id));
  }

  await db
    .update(documents)
    .set({ status: "archived", archivedAt: now, updatedAt: now })
    .where(eq(documents.id, id));

  await db.insert(activityLog).values({
    entityType: "document",
    entityId: id,
    kind: "review",
    text: `${auth.name ?? auth.email ?? "系統"} 手動連結至 ${body.targetType === "purchase" ? "採購案" : "資產"} ${body.targetId}`,
    actorMemberId: auth.memberId,
  });

  return c.json({ ok: true });
});

// 待覆核畫面「標示重複」「略過」「標示失敗」等不需要連結物件的操作,直接改狀態。
documentsRoute.post("/:id/status", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const id = c.req.param("id");
  const body = await c.req.json<{ status: string; note?: string }>();
  const db = createDb(c.env.DB);
  const now = new Date().toISOString();

  await db
    .update(documents)
    .set({
      status: body.status,
      archivedAt: body.status === "archived" ? now : undefined,
      updatedAt: now,
    })
    .where(eq(documents.id, id));

  await db.insert(activityLog).values({
    entityType: "document",
    entityId: id,
    kind: body.status === "dup" ? "dup" : body.status === "failed" ? "failed" : "review",
    text: body.note ?? `${auth.name ?? auth.email ?? "系統"} 將狀態改為 ${body.status}`,
    actorMemberId: auth.memberId,
  });

  return c.json({ ok: true });
});

// 失敗文件重新排入佇列(document_processing_jobs.status='failed' 的補救操作)。
documentsRoute.post("/:id/retry", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const id = c.req.param("id");
  const db = createDb(c.env.DB);
  await db.update(documents).set({ status: "queued", updatedAt: new Date().toISOString() }).where(eq(documents.id, id));
  await c.env.DOCUMENT_QUEUE.send({ documentId: id, reason: "retry" });

  await db.insert(activityLog).values({
    entityType: "document",
    entityId: id,
    kind: "review",
    text: `${auth.name ?? auth.email ?? "系統"} 重新排入處理佇列`,
    actorMemberId: auth.memberId,
  });

  return c.json({ ok: true });
});
