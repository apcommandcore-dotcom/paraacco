// 文件(人類使用者端)—— 規格 2.5、2.9、3.5(收件匣＋待覆核工作台)。
//
// v2 架構邊界(範圍決策:OCR pipeline 改用 Cloudflare Queues + Workflows):這支路由只處理
// 「人類使用者」看得到、按得到的操作(收件匣上傳登記、待覆核畫面讀取候選/確認關聯/標記狀態)。
// document-worker 的 Workflow 步驟一律呼叫 /internal/* 端點(見 routes/internal/),不是
// 這支路由 —— 兩邊分開是因為驗證方式完全不同(人類走 Cloudflare Access,Workflow 走
// Service Binding + 共用密鑰)。

import { Hono } from "hono";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import {
  activityLog,
  assets,
  createDb,
  documentAssetLinks,
  documentExtractedFields,
  documentFiles,
  documentProcessingJobs,
  documentPurchaseLinks,
  documents,
  nextId,
  purchases,
  relationCandidates,
  syncDocumentFts,
} from "@paraacco/db";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";
import { attachDocument, ObjectError } from "../purchase-objects";

export const documentsRoute = new Hono<{ Bindings: Bindings }>();

// ownership 篩選 —— 2026-09-07 補完設計落差任務書任務 2(範圍切換器),沿用既有的
// ownership 欄位(per/corp/advance/custody),不是新欄位。
documentsRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const status = c.req.query("status");
  const ownership = c.req.query("ownership");
  // vendorId 篩選 —— 2026-09-16「依標題瀏覽」入口新增,見架構文件第 1 節。
  const vendorId = c.req.query("vendorId");
  const conditions = [
    status ? eq(documents.status, status) : undefined,
    ownership ? eq(documents.ownership, ownership) : undefined,
    vendorId ? eq(documents.vendorId, vendorId) : undefined,
  ].filter((v) => v !== undefined);
  // ownershipScope(2026-09-28,CODE_TASK V1.04):信用卡帳單/銀行對帳單是「共用」,documents.ownership 的 CHECK
  // 沒有這個值(改要重建表),存在 document_extracted_fields.ownership_scope='shared',列表直接帶出來給前端顯示。
  const listColumns = {
    ...getTableColumns(documents),
    // 外層欄位要寫成 "documents"."id":drizzle 在 select 裡把 ${documents.id} 渲染成不帶表名的 "id",會被子查詢的表吃掉。
    ownershipScope: sql<string | null>`(SELECT e.value FROM document_extracted_fields e WHERE e.document_id = "documents"."id" AND e.field_key = 'ownership_scope')`,
    // 2026-09-29(CODE_TASK_vendor-name-from-taxid_20260929.md R-V1):顯示用的「對象」一律用主檔名稱;
    // vendorId 為空(統編未建檔/無法辨識)時前端才退回 OCR 店名並標「未建檔」。
    vendorName: sql<string | null>`(SELECT v.name FROM vendors v WHERE v.id = "documents"."vendor_id")`,
    vendorStatus: sql<string | null>`(SELECT e.value FROM document_extracted_fields e WHERE e.document_id = "documents"."id" AND e.field_key = 'vendor_status')`,
    // 2026-09-29(CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md):所屬物件與角色——列表把附件收在主文件底下。
    purchaseId: sql<string | null>`(SELECT l.purchase_id FROM document_purchase_links l WHERE l.document_id = "documents"."id" AND l.relation_kind <> 'duplicate_evidence' LIMIT 1)`,
    purchaseRelation: sql<string | null>`(SELECT l.relation_kind FROM document_purchase_links l WHERE l.document_id = "documents"."id" AND l.relation_kind <> 'duplicate_evidence' LIMIT 1)`,
    attachmentRole: sql<string | null>`(SELECT l.attachment_role FROM document_purchase_links l WHERE l.document_id = "documents"."id" AND l.relation_kind <> 'duplicate_evidence' LIMIT 1)`,
  };
  const rows = conditions.length
    ? await db
        .select(listColumns)
        .from(documents)
        .where(and(...conditions))
        .orderBy(desc(documents.createdAt))
    : await db.select(listColumns).from(documents).orderBy(desc(documents.createdAt));

  // 收件匣畫面要顯示 pipeline 進度(8 步驟簡化版:current_stage/stage_key)——一份文件
  // 可能因為 retry 累積多筆 job(見 CODE_REPORT_queue-consumer-fix-retest_20260904.md 的
  // 副作用發現),這裡只取每份文件最新建立的那一筆。
  //
  // 2026-09-22 修正:原本用 rows.map(r => r.id) 組一份 ID 清單餵給 inArray,文件一多
  // (200+ 筆)就超過 D1 單查詢 100 bound params 上限,回 internal_error。改成子查詢重用
  // 上面同一組篩選條件(and(...conditions)),讓 D1 自己關聯,綁定參數數量只跟篩選條件
  // 個數成正比,不跟文件筆數成正比。
  const jobs = rows.length
    ? await db
        .select()
        .from(documentProcessingJobs)
        .where(
          inArray(
            documentProcessingJobs.documentId,
            conditions.length
              ? db.select({ id: documents.id }).from(documents).where(and(...conditions))
              : db.select({ id: documents.id }).from(documents),
          ),
        )
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

  // purchaseLinks/assetLinks 補 join 對應項目的 summary/amountCents/status(2026-09-19,
  // 「彈性標籤項目」拆項功能——文件詳情頁「關聯」區原本只顯示 purchaseId/assetId 這種內部
  // ID,使用者看不出這個關聯項目實際是什麼、多少錢,這裡補 join 進去讓 UI 能顯示品名/金額,
  // 不動 document_purchase_links/document_asset_links 本身的資料,單純多查一次 join。
  const [fields, files, purchaseLinkRows, assetLinkRows, jobs] = await Promise.all([
    db.select().from(documentExtractedFields).where(eq(documentExtractedFields.documentId, id)).orderBy(documentExtractedFields.sortOrder),
    db.select().from(documentFiles).where(eq(documentFiles.documentId, id)),
    db
      .select({
        purchaseId: documentPurchaseLinks.purchaseId,
        relationKind: documentPurchaseLinks.relationKind,
        linkedBy: documentPurchaseLinks.linkedBy,
        confidenceScore: documentPurchaseLinks.confidenceScore,
        summary: purchases.summary,
        amountCents: purchases.amountCents,
        currency: purchases.currency,
        status: purchases.status,
      })
      .from(documentPurchaseLinks)
      .leftJoin(purchases, eq(documentPurchaseLinks.purchaseId, purchases.id))
      .where(eq(documentPurchaseLinks.documentId, id)),
    db
      .select({
        assetId: documentAssetLinks.assetId,
        relationKind: documentAssetLinks.relationKind,
        linkedBy: documentAssetLinks.linkedBy,
        confidenceScore: documentAssetLinks.confidenceScore,
        name: assets.name,
        amountCents: assets.amountCents,
        currency: assets.currency,
        status: assets.status,
      })
      .from(documentAssetLinks)
      .leftJoin(assets, eq(documentAssetLinks.assetId, assets.id))
      .where(eq(documentAssetLinks.documentId, id)),
    db.select().from(documentProcessingJobs).where(eq(documentProcessingJobs.documentId, id)).orderBy(desc(documentProcessingJobs.createdAt)),
  ]);

  // processingJobs 給文件詳情頁「進階／稽核」區用(2026-09-16,v8 設計稿分層對齊)——
  // 完整處理歷程(含 retry 次數/失敗原因),不是只有最新一筆;processingJob 保留給列表頁
  // 沿用的簡化欄位,不拿掉避免動到既有呼叫端。
  return c.json({
    document: doc,
    fields,
    files,
    purchaseLinks: purchaseLinkRows,
    assetLinks: assetLinkRows,
    processingJob: jobs[0] ?? null,
    processingJobs: jobs,
    // storage='local' 的檔案位置相對於這裡(2026-09-28),前端組完整 NAS 路徑用。
    localRoot: c.env.LOCAL_ROOT,
  });
});

// 待覆核工作台中欄要顯示原始檔案(PDF/圖片)——直接把 R2 物件內容串流回來,不给前端另外處理
// R2 存取權限(bucket 本身不公開)。可以用 ?kind= 指定 kind。
// 2026-09-26:沒指定 kind 時優先回傳目前生效的 normalized_pdf(裁切空白+轉正後的顯示檔,
// 見 routes/extraction-writeback.ts 的 normalized-file 端點),沒有才回 original;
// ?kind=original 永遠拿原始掃描檔。
// 2026-09-28:storage='local'(原始檔只留 NAS)時不串流檔案,回 JSON
// { storage:"local", localRoot, localPath, ... },前端顯示 NAS 路徑讓使用者自己開。
documentsRoute.get("/:id/file", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const requestedKind = c.req.query("kind");
  const kinds = requestedKind ? [requestedKind] : ["normalized_pdf", "original"];

  let file: typeof documentFiles.$inferSelect | undefined;
  for (const kind of kinds) {
    [file] = await db
      .select()
      .from(documentFiles)
      .where(and(eq(documentFiles.documentId, id), eq(documentFiles.kind, kind), eq(documentFiles.isCurrent, true)))
      .limit(1);
    if (file) break;
  }
  if (!file) return c.json({ error: "not_found" }, 404);

  if (file.storage === "local") {
    return c.json({
      storage: "local",
      localRoot: c.env.LOCAL_ROOT,
      localPath: file.localPath,
      kind: file.kind,
      originalFileName: file.originalFileName,
      mimeType: file.mimeType,
      byteSize: file.byteSize,
      sha256: file.sha256,
    });
  }

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

// 網頁上傳登記(收件匣「快速上傳」、資產「新增說明書」)——2026-09-28 停用:唯一入口是 NAS 的
// Bookkeeper_Scanner,原始檔只留 NAS(CODE_TASK_local-originals-nas-path_20260927_V1.01.md)。
// 先回 410 附說明,下一版再刪路由。
documentsRoute.post("/", (c) =>
  c.json(
    {
      error: "gone",
      message: "網頁上傳已停用。請把檔案放進 NAS 的 Bookkeeper_Scanner 資料夾,每日排程會自動進件。",
    },
    410,
  ),
);

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
    // 2026-09-29:採購案 = 物件。走物件的加入規則(發票接手主文件、其餘當附件、一份文件只屬一個物件),
    // 不再直接插一列 primary(會讓一個物件有兩份主文件)。relationKind 'primary' 以外的舊值忽略,由文件種類決定。
    try {
      await attachDocument(db, body.targetId, id, {
        role: body.relationKind === "primary" ? "primary" : null,
        actor: { memberId: auth.memberId, name: auth.name ?? auth.email ?? null },
      });
    } catch (err) {
      if (err instanceof ObjectError) return c.json({ error: err.code, message: err.message }, err.status);
      throw err;
    }
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

// 文件顯示名稱編輯(2026-09-18,對應 CODE_TASK_flexible-item-object-model_20260916.md
// 「標題可編輯」的前端/API 這一半)—— documents.display_name 欄位 2026-09-13 就已經在
// schema 裡(見 packages/db/src/schema.ts)。「OCR 自動判讀出品名當預設值」那一半(Gemini
// 擷取 prompt 新增 itemName 欄位、/internal/documents/:id/classify 只在該欄還是 null 時
// 寫入)已經在 CODE_TASK_document-fields-additions_20260918.md 補上——這個路由是使用者
// 手動編輯那一半,兩者共用同一個「已有值不覆蓋」規則(這裡是人工操作,一律直接覆蓋成
// 使用者輸入的值,不需要額外判斷)。
documentsRoute.post("/:id/display-name", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const id = c.req.param("id");
  const body = await c.req.json<{ displayName?: string | null }>().catch(() => ({}) as { displayName?: string | null });
  const raw = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const displayName = raw ? raw.slice(0, 200) : null;

  const db = createDb(c.env.DB);
  const [existing] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  if (!existing) return c.json({ error: "not found" }, 404);

  await db.update(documents).set({ displayName, updatedAt: new Date().toISOString() }).where(eq(documents.id, id));

  await db.insert(activityLog).values({
    entityType: "document",
    entityId: id,
    kind: "review",
    text: `${auth.name ?? auth.email ?? "系統"} 修改文件顯示名稱為「${displayName ?? "(清空)"}」`,
    actorMemberId: auth.memberId,
  });

  return c.json({ ok: true, displayName });
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
