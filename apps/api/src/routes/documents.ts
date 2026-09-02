// 文件 —— 規格 2.5、2.9、3.5(收件匣＋待覆核工作台)。這支路由是整個 OCR → 關聯 → 覆核
// 工作流程的核心,也是 document-worker 唯一被允許寫入資料的管道(見架構邊界:
// document-worker 的 wrangler.toml 刻意不掛 D1 binding)。

import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import {
  activityLog,
  assets,
  createDb,
  documentFields,
  documents,
  purchases,
  vendorAliases,
  vendors,
} from "@paraacco/db";
import {
  findRegisteredVendor,
  rankCandidates,
  requiresForcedReview,
  type MatchCandidateInput,
} from "@paraacco/domain";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";

export const documentsRoute = new Hono<{ Bindings: Bindings }>();

documentsRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const status = c.req.query("status");
  const rows = status
    ? await db.select().from(documents).where(eq(documents.status, status)).orderBy(desc(documents.createdAt))
    : await db.select().from(documents).orderBy(desc(documents.createdAt));
  return c.json({ documents: rows });
});

documentsRoute.get("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const [doc] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  if (!doc) return c.json({ error: "not_found" }, 404);
  const fields = await db
    .select()
    .from(documentFields)
    .where(eq(documentFields.documentId, id))
    .orderBy(documentFields.sortOrder);
  return c.json({ document: doc, fields });
});

// 收件匣建立草稿紀錄(檔案本身已由前端直接 PUT 到 R2 預簽 URL,這裡只登記 metadata)。
documentsRoute.post("/", async (c) => {
  const body = await c.req.json<{
    id: string;
    ownership: string;
    fileName: string;
    source: string;
    r2Key: string;
  }>();

  const db = createDb(c.env.DB);
  await db.insert(documents).values({
    id: body.id,
    ownership: body.ownership,
    fileName: body.fileName,
    source: body.source,
    r2Key: body.r2Key,
    status: "queued",
    pipelineStep: 1,
  });

  await db.insert(activityLog).values({
    entityType: "document",
    entityId: body.id,
    kind: "import",
    text: `新文件匯入:${body.fileName}`,
  });

  return c.json({ ok: true, id: body.id }, 201);
});

// document-worker 呼叫這個端點回寫 OCR 結果 —— 套用供應商主檔強制覆核規則(規格 2.6)與
// SHA-256 重複偵測,決定文件下一個狀態是 'extract'(等待人工覆核前的最後步驟)還是直接
// 'review' / 'dup'。document-worker 本身不判斷這些業務規則,規則統一在這裡執行。
documentsRoute.post("/:id/ocr-result", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    ownership?: string;
    vendorNameRaw?: string;
    vendorTaxId?: string;
    vendorAliasCandidates?: string[];
    docTypeCode?: string;
    docDate?: string;
    amountCents?: number;
    ocrConfidence?: number;
    sha256?: string;
    fields?: Array<{ key: string; label: string; value: string; confidence: number; mono?: boolean; source: string }>;
  }>();

  const db = createDb(c.env.DB);

  const vendorRows = await db.select().from(vendors);
  const aliasRows = await db.select().from(vendorAliases);
  const vendorRecords = vendorRows.map((v) => ({
    id: v.id,
    name: v.name,
    taxId: v.taxId,
    aliases: aliasRows.filter((a) => a.vendorId === v.id).map((a) => a.alias),
  }));
  const matchedVendor = findRegisteredVendor(
    { nameRaw: body.vendorNameRaw, taxId: body.vendorTaxId, aliasCandidates: body.vendorAliasCandidates },
    vendorRecords,
  );
  const forcedReview = requiresForcedReview(matchedVendor);

  let duplicateOfDocumentId: string | null = null;
  if (body.sha256) {
    const [dup] = await db.select().from(documents).where(eq(documents.sha256, body.sha256)).limit(1);
    if (dup && dup.id !== id) duplicateOfDocumentId = dup.id;
  }

  const status = duplicateOfDocumentId ? "dup" : forcedReview ? "review" : "extract";
  const pipelineStep = duplicateOfDocumentId || forcedReview ? 8 : 6;

  await db
    .update(documents)
    .set({
      ownership: body.ownership,
      vendorId: matchedVendor?.id ?? null,
      vendorNameRaw: body.vendorNameRaw,
      docTypeCode: body.docTypeCode,
      docDate: body.docDate,
      amountCents: body.amountCents,
      ocrConfidence: body.ocrConfidence,
      sha256: body.sha256,
      duplicateOfDocumentId,
      status,
      pipelineStep,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(documents.id, id));

  if (body.fields?.length) {
    await db.delete(documentFields).where(eq(documentFields.documentId, id));
    await db.insert(documentFields).values(
      body.fields.map((f, i) => ({
        documentId: id,
        fieldKey: f.key,
        label: f.label,
        value: f.value,
        confidence: f.confidence,
        isMono: !!f.mono,
        sourceNote: f.source,
        sortOrder: i,
      })),
    );
  }

  await db.insert(activityLog).values({
    entityType: "document",
    entityId: id,
    kind: duplicateOfDocumentId ? "dup" : "ocr",
    text: duplicateOfDocumentId
      ? `偵測到疑似重複文件(與 ${duplicateOfDocumentId} SHA-256 相同)`
      : `OCR 欄位擷取完成,信心值 ${body.ocrConfidence ?? "—"}%${forcedReview ? "(供應商未登記主檔,強制送覆核)" : ""}`,
  });

  return c.json({ ok: true, status, matchedVendorId: matchedVendor?.id ?? null, duplicateOfDocumentId });
});

// 待覆核畫面右欄「關聯候選」—— 即時運算,不落地存表(見規格文件缺口清單第 4 點的討論)。
documentsRoute.get("/:id/candidates", async (c) => {
  const id = c.req.param("id");
  const db = createDb(c.env.DB);
  const [doc] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  if (!doc) return c.json({ error: "not_found" }, 404);

  const fields = await db.select().from(documentFields).where(eq(documentFields.documentId, id));
  const fieldValue = (key: string) => fields.find((f) => f.fieldKey === key)?.value ?? undefined;

  const docFields = {
    orderNo: fieldValue("orderNo"),
    serialNo: fieldValue("serial"),
    invoiceNo: fieldValue("invoiceNo"),
    brand: fieldValue("brand"),
    model: fieldValue("model"),
    vendorId: doc.vendorId ?? undefined,
    vendorNameRaw: doc.vendorNameRaw ?? undefined,
    amountCents: doc.amountCents ?? undefined,
    date: doc.docDate ?? undefined,
  };

  const purchaseRows = await db.select().from(purchases);
  const assetRows = await db.select().from(assets);

  const candidateInputs: MatchCandidateInput[] = [
    ...purchaseRows.map((p) => ({
      kind: "purchase" as const,
      id: p.id,
      fields: {
        orderNo: p.orderNo ?? undefined,
        invoiceNo: p.invoiceNo ?? undefined,
        vendorId: p.vendorId ?? undefined,
        vendorNameRaw: p.vendorNameRaw,
        amountCents: p.amountCents,
        date: p.purchaseDate,
      },
    })),
    ...assetRows.map((a) => ({
      kind: "asset" as const,
      id: a.id,
      fields: {
        serialNo: a.serialNo ?? undefined,
        brand: a.brand ?? undefined,
        model: a.model ?? undefined,
        date: a.acquiredDate ?? undefined,
      },
    })),
  ];

  return c.json({ candidates: rankCandidates(docFields, candidateInputs) });
});

// 待覆核畫面底部「確認並歸檔」/「連結既有購買案／資產」。
documentsRoute.post("/:id/link", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const id = c.req.param("id");
  const body = await c.req.json<{ purchaseId?: string; assetId?: string }>();
  const db = createDb(c.env.DB);

  await db
    .update(documents)
    .set({
      purchaseId: body.purchaseId ?? null,
      assetId: body.assetId ?? null,
      status: "archived",
      pipelineStep: 8,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(documents.id, id));

  await db.insert(activityLog).values({
    entityType: "document",
    entityId: id,
    kind: "review",
    text: `${auth.name ?? auth.email ?? "系統"} 確認並歸檔`,
    actorMemberId: auth.memberId,
  });

  return c.json({ ok: true });
});

// 待覆核畫面「標示重複」「略過」等不需要連結物件的操作,直接改狀態。
documentsRoute.post("/:id/status", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const id = c.req.param("id");
  const body = await c.req.json<{ status: string; note?: string }>();
  const db = createDb(c.env.DB);

  await db
    .update(documents)
    .set({ status: body.status, updatedAt: new Date().toISOString() })
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
