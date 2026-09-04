// /internal/documents/* —— 只給 apps/document-worker 的 Workflow 步驟透過 Service Binding
// 呼叫,套用 internalAuthMiddleware(共用密鑰),不是給人類使用者用的路由(見 routes/documents.ts
// 開頭說明的架構邊界)。document-worker 本身不掛 D1 binding,所有寫入都要經過這裡。
//
// 業務規則(供應商強制覆核、關聯評分/決標、重複偵測)统一在這裡執行,document-worker 只負責
// 呼叫 OCR provider、把結果丟過來,不自己判斷規則 —— 跟 v1 的分工原則一致。

import { Hono } from "hono";
import { and, eq, ne } from "drizzle-orm";
import {
  activityLog,
  assets,
  createDb,
  documentAssetLinks,
  documentExtractedFields,
  documentFiles,
  documentPurchaseLinks,
  documents,
  purchases,
  relationCandidates,
  syncDocumentFts,
  vendorAliases,
  vendors,
} from "@paraacco/db";
import {
  findRegisteredVendor,
  rankCandidates,
  requiresForcedReview,
  resolveAutoLink,
  type MatchCandidateInput,
} from "@paraacco/domain";
import type { Bindings } from "../../bindings";

export const internalDocumentsRoute = new Hono<{ Bindings: Bindings }>();

const ALGORITHM_VERSION = "v2";

// Workflow 步驟需要讀 documents + document_files(特別是 original 檔案的 r2Key)才能去 R2
// 抓檔案內容跑 OCR —— document-worker 沒有 D1 binding,只能透過這個端點取得。
internalDocumentsRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  const db = createDb(c.env.DB);
  const [doc] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  if (!doc) return c.json({ error: "not_found" }, 404);
  const [files, fields] = await Promise.all([
    db.select().from(documentFiles).where(eq(documentFiles.documentId, id)),
    db.select().from(documentExtractedFields).where(eq(documentExtractedFields.documentId, id)),
  ]);
  return c.json({ document: doc, files, fields });
});

// 階段 2(validating)之後、階段 3(ocr)開始前,把 R2 裡實際存在的檔案版本登記進
// document_files(normalized_pdf/page_image/thumbnail/ocr_json 等,original 在人類上傳
// 當下就已經由 routes/documents.ts 登記過了)。
internalDocumentsRoute.post("/:id/files", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    kind: string;
    r2Key: string;
    originalFileName: string;
    mimeType: string;
    byteSize: number;
    sha256?: string;
    pageNumber?: number;
    isCurrent?: boolean;
  }>();

  const db = createDb(c.env.DB);
  await db.insert(documentFiles).values({
    documentId: id,
    kind: body.kind,
    r2Key: body.r2Key,
    originalFileName: body.originalFileName,
    mimeType: body.mimeType,
    byteSize: body.byteSize,
    sha256: body.sha256 ?? null,
    pageNumber: body.pageNumber ?? null,
    isCurrent: body.isCurrent ?? true,
  });

  return c.json({ ok: true });
});

// 階段 2(validating):比對 sha256 是否跟既有的 original 檔案重複(不含自己)。
internalDocumentsRoute.post("/:id/duplicate-check", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ sha256: string }>();
  const db = createDb(c.env.DB);

  const rows = await db
    .select({ documentId: documentFiles.documentId })
    .from(documentFiles)
    .where(
      and(
        eq(documentFiles.kind, "original"),
        eq(documentFiles.sha256, body.sha256),
        eq(documentFiles.isCurrent, true),
        ne(documentFiles.documentId, id),
      ),
    )
    .limit(1);

  return c.json({ duplicateOfDocumentId: rows[0]?.documentId ?? null });
});

// 階段 4(extract):寫入 OCR 擷取到的欄位(document_extracted_fields),並同步全文檢索索引。
internalDocumentsRoute.post("/:id/fields", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    fields: Array<{
      fieldKey: string;
      label: string;
      value?: string;
      normalizedValue?: string;
      confidence?: number;
      extractionSource: string;
      sourceNote?: string;
      isMono?: boolean;
      pageNumber?: number;
      bboxJson?: string;
      sortOrder?: number;
    }>;
  }>();

  const db = createDb(c.env.DB);
  await db.delete(documentExtractedFields).where(eq(documentExtractedFields.documentId, id));
  if (body.fields.length) {
    await db.insert(documentExtractedFields).values(
      body.fields.map((f, i) => ({
        documentId: id,
        fieldKey: f.fieldKey,
        label: f.label,
        value: f.value ?? null,
        normalizedValue: f.normalizedValue ?? null,
        confidence: f.confidence ?? null,
        extractionSource: f.extractionSource,
        sourceNote: f.sourceNote ?? null,
        isMono: f.isMono ?? false,
        pageNumber: f.pageNumber ?? null,
        bboxJson: f.bboxJson ?? null,
        sortOrder: f.sortOrder ?? i,
      })),
    );
  }

  await syncDocumentFts(db, id);
  return c.json({ ok: true });
});

// 階段 5(classifying):寫入文件層級的分類結果 —— 促升到 documents 直欄的識別欄位
// (invoiceNo/orderNo/serialNo/brand/model)、金額、日期、整體信心分數(由 document-worker
// 用 @paraacco/domain 的 calculateOverallConfidence() 算好再傳進來,這裡只負責存)。
internalDocumentsRoute.post("/:id/classify", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    docTypeCode?: string;
    docDate?: string;
    invoiceNo?: string;
    orderNo?: string;
    serialNo?: string;
    brand?: string;
    model?: string;
    amountCents?: number;
    currency?: string;
    vendorNameRaw?: string;
    ocrConfidence?: number;
  }>();

  const db = createDb(c.env.DB);
  await db
    .update(documents)
    .set({
      docTypeCode: body.docTypeCode ?? null,
      docDate: body.docDate ?? null,
      invoiceNo: body.invoiceNo ?? null,
      orderNo: body.orderNo ?? null,
      serialNo: body.serialNo ?? null,
      brand: body.brand ?? null,
      model: body.model ?? null,
      amountCents: body.amountCents ?? null,
      currency: body.currency ?? "TWD",
      vendorNameRaw: body.vendorNameRaw ?? null,
      ocrConfidence: body.ocrConfidence ?? null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(documents.id, id));

  return c.json({ ok: true });
});

// 階段 7(vendor_check):供應商主檔強制覆核規則(規格 2.6)—— 未登記於主檔一律強制送人工
// 覆核,不受分數影響,獨立生效優先於下面的關聯評分結果。
internalDocumentsRoute.post("/:id/vendor-check", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    vendorNameRaw?: string;
    vendorTaxId?: string;
    vendorAliasCandidates?: string[];
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

  await db
    .update(documents)
    .set({ vendorId: matchedVendor?.id ?? null, updatedAt: new Date().toISOString() })
    .where(eq(documents.id, id));

  return c.json({ matchedVendorId: matchedVendor?.id ?? null, forcedReview });
});

// 階段 6(matching):對既有 purchases/assets 評分(見 domain/matching.ts),落地存進
// relation_candidates(先清掉這份文件之前還 pending 的舊候選,避免 retry 後重複堆積),
// 並試著決標(resolveAutoLink)。回傳結果讓 Workflow 決定下一步是直接自動關聯,還是留給
// 階段 8(decision)送人工覆核。
internalDocumentsRoute.post("/:id/compute-candidates", async (c) => {
  const id = c.req.param("id");
  const db = createDb(c.env.DB);

  const [doc] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  if (!doc) return c.json({ error: "not_found" }, 404);

  const docFields = {
    orderNo: doc.orderNo ?? undefined,
    serialNo: doc.serialNo ?? undefined,
    invoiceNo: doc.invoiceNo ?? undefined,
    brand: doc.brand ?? undefined,
    model: doc.model ?? undefined,
    vendorId: doc.vendorId ?? undefined,
    vendorNameRaw: doc.vendorNameRaw ?? undefined,
    amountCents: doc.amountCents ?? undefined,
    date: doc.docDate ?? undefined,
  };

  const [purchaseRows, assetRows] = await Promise.all([db.select().from(purchases), db.select().from(assets)]);

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

  const ranked = rankCandidates(docFields, candidateInputs);

  const stalePending = await db
    .select({ id: relationCandidates.id })
    .from(relationCandidates)
    .where(and(eq(relationCandidates.documentId, id), eq(relationCandidates.decision, "pending")));
  for (const row of stalePending) {
    await db.delete(relationCandidates).where(eq(relationCandidates.id, row.id));
  }

  if (ranked.length) {
    await db.insert(relationCandidates).values(
      ranked.map((r) => ({
        documentId: id,
        targetType: r.kind,
        targetId: r.id,
        score: r.score,
        rawScore: r.rawScore,
        reasonsJson: JSON.stringify(r.reasons),
        algorithmVersion: ALGORITHM_VERSION,
        decision: "pending" as const,
      })),
    );
  }

  const autoLink = resolveAutoLink(ranked);
  return c.json({ candidates: ranked, autoLink: autoLink ?? null });
});

// 階段 8(decision)其中一條路徑:高信心自動關聯成功(compute-candidates 回傳的 autoLink
// 非 null)且供應商已登記(vendor-check 的 forcedReview=false)時,系統自動關聯並歸檔,
// 不需要人工介入。actorMemberId 為 null,activity_log 顯示為「系統」。
internalDocumentsRoute.post("/:id/auto-link", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ targetType: "purchase" | "asset"; targetId: string; score: number }>();
  const db = createDb(c.env.DB);
  const now = new Date().toISOString();

  if (body.targetType === "purchase") {
    await db.insert(documentPurchaseLinks).values({
      documentId: id,
      purchaseId: body.targetId,
      relationKind: "primary",
      linkedBy: "auto",
      confidenceScore: body.score,
    });
  } else {
    await db.insert(documentAssetLinks).values({
      documentId: id,
      assetId: body.targetId,
      relationKind: "primary",
      linkedBy: "auto",
      confidenceScore: body.score,
    });
  }

  const pendingCandidates = await db
    .select({ id: relationCandidates.id, targetId: relationCandidates.targetId })
    .from(relationCandidates)
    .where(and(eq(relationCandidates.documentId, id), eq(relationCandidates.decision, "pending")));
  for (const cand of pendingCandidates) {
    await db
      .update(relationCandidates)
      .set({ decision: cand.targetId === body.targetId ? "accepted" : "superseded", decidedAt: now })
      .where(eq(relationCandidates.id, cand.id));
  }

  await db.update(documents).set({ status: "archived", archivedAt: now, updatedAt: now }).where(eq(documents.id, id));

  await db.insert(activityLog).values({
    entityType: "document",
    entityId: id,
    kind: "review",
    text: `系統自動關聯至${body.targetType === "purchase" ? "採購案" : "資產"} ${body.targetId}(信心分數 ${body.score})`,
  });

  return c.json({ ok: true });
});

// 階段 8(decision)其餘路徑:review(送人工覆核)、dup(重複)、failed(無法重試的錯誤)、
// ignored 由 Workflow 依 compute-candidates/vendor-check/duplicate-check 的結果決定,
// 呼叫這裡落地寫入最終狀態。
internalDocumentsRoute.post("/:id/decide", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ status: string; note?: string }>();
  const db = createDb(c.env.DB);
  const now = new Date().toISOString();

  await db
    .update(documents)
    .set({ status: body.status, archivedAt: body.status === "archived" ? now : undefined, updatedAt: now })
    .where(eq(documents.id, id));

  await db.insert(activityLog).values({
    entityType: "document",
    entityId: id,
    kind: body.status === "dup" ? "dup" : body.status === "failed" ? "failed" : "review",
    text: body.note ?? `系統將文件狀態轉為 ${body.status}`,
  });

  return c.json({ ok: true });
});
