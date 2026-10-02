// 採購案 —— 規格 2.3、3.2(清單頁「依購買案」view)。
// v2:新增 payerKind(代墊人身分,對應範圍決策——這裡算的是「代墊」項目,見 schema.ts 開頭
// 註解)、reimbursementStatus 較完整的狀態集合、createdByMemberId 記錄是哪個成員(會計／
// 負責人)建立這筆紀錄。

import { Hono, type Context } from "hono";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  activityLog,
  createDb,
  documentPurchaseLinks,
  documents,
  nextId,
  purchaseAttachments,
  purchaseItems,
  purchases,
  purchaseTags,
} from "@paraacco/db";
import { pickPrimary } from "@paraacco/domain";
import { validateLocalPath } from "@paraacco/shared";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";
import {
  attachDocument,
  createObject,
  detachDocument,
  getObjectDetail,
  loadMergeDocs,
  mergeCandidatesFor,
  ObjectError,
  type Actor,
} from "../purchase-objects";
import { parseItemBody, type ItemBody } from "./purchase-items";

export const purchasesRoute = new Hono<{ Bindings: Bindings }>();

// ownership 篩選 —— 2026-09-07 補完設計落差任務書任務 2(範圍切換器),沿用既有的
// ownership 欄位(per/corp/advance/custody),不是新欄位。entityId/projectId 篩選是
// 2026-09-13 財務文件自動分類新增(架構文件第 6 節「List 畫面擴充篩選」)。
purchasesRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const status = c.req.query("status");
  const ownership = c.req.query("ownership");
  const entityId = c.req.query("entityId");
  const projectId = c.req.query("projectId");
  // vendorId 篩選 —— 2026-09-16「依標題瀏覽」入口新增,見架構文件第 1 節。
  const vendorId = c.req.query("vendorId");
  const conditions = [
    status ? eq(purchases.status, status) : undefined,
    ownership ? eq(purchases.ownership, ownership) : undefined,
    entityId ? eq(purchases.entityId, entityId) : undefined,
    projectId ? eq(purchases.projectId, projectId) : undefined,
    vendorId ? eq(purchases.vendorId, vendorId) : undefined,
  ].filter((v) => v !== undefined);
  const rows = conditions.length
    ? await db
        .select()
        .from(purchases)
        .where(and(...conditions))
        .orderBy(desc(purchases.purchaseDate))
    : await db.select().from(purchases).orderBy(desc(purchases.purchaseDate));
  return c.json({ purchases: rows });
});

// ---------------------------------------------------------------------------
// 物件(2026-09-29,CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md)——採購案 = 物件 = 一筆消費。
// 這幾條要排在 GET /:id 之前(靜態路徑優先)。規則與寫入邏輯在 ../purchase-objects.ts。
// ---------------------------------------------------------------------------
function actorOf(auth: { memberId: string | null; name: string | null; email: string | null }): Actor {
  return { memberId: auth.memberId, name: auth.name ?? auth.email ?? null };
}

function objectErrorResponse(c: Context, err: unknown) {
  if (err instanceof ObjectError) return c.json({ error: err.code, message: err.message }, err.status);
  throw err;
}

// 覆核頁「合併到物件」的系統建議(第三節規則 1–5)。
purchasesRoute.get("/merge-candidates", async (c) => {
  const documentId = c.req.query("documentId");
  if (!documentId) return c.json({ error: "missing_document_id" }, 400);
  const result = await mergeCandidatesFor(createDb(c.env.DB), documentId);
  if (!result) return c.json({ error: "not_found" }, 404);
  return c.json(result);
});

// 一鍵合併:documentIds 裡已經有物件就加進那個物件,都沒有就建新物件(主文件 = primaryDocumentId,沒給就依發票優先自動選)。
// roles:{ documentId: 'primary' | 附件類型 },itemLineNos:{ documentId: 品項行號 }(新建物件時掛品項層)。
purchasesRoute.post("/merge", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req
    .json<{ documentIds?: unknown; primaryDocumentId?: string; roles?: Record<string, string>; itemLineNos?: Record<string, number> }>()
    .catch(() => null);
  const ids = Array.isArray(body?.documentIds) ? [...new Set(body!.documentIds.filter((x): x is string => typeof x === "string"))] : [];
  if (ids.length < 1) return c.json({ error: "missing_document_ids" }, 400);
  const db = createDb(c.env.DB);
  const actor = actorOf(auth);
  try {
    const existingLinks = await db
      .select({ documentId: documentPurchaseLinks.documentId, purchaseId: documentPurchaseLinks.purchaseId })
      .from(documentPurchaseLinks)
      .where(and(inArray(documentPurchaseLinks.documentId, ids), ne(documentPurchaseLinks.relationKind, "duplicate_evidence")));
    const objectIds = [...new Set(existingLinks.map((l) => l.purchaseId))];
    if (objectIds.length > 1) return c.json({ error: "multiple_objects", message: `這些文件分屬不同物件(${objectIds.join("、")}),請先移出再合併` }, 409);
    if (objectIds.length === 1) {
      const purchaseId = objectIds[0];
      const results = [];
      const ordered = body?.primaryDocumentId ? [body.primaryDocumentId, ...ids.filter((i) => i !== body.primaryDocumentId)] : ids;
      for (const id of ordered) {
        if (existingLinks.some((l) => l.documentId === id) && id !== body?.primaryDocumentId) continue;
        const role = id === body?.primaryDocumentId ? "primary" : (body?.roles?.[id] ?? null);
        results.push({ documentId: id, ...(await attachDocument(db, purchaseId, id, { role, actor })) });
      }
      return c.json({ ok: true, purchaseId, created: false, results });
    }
    const docs = await db.select({ id: documents.id }).from(documents).where(inArray(documents.id, ids));
    if (docs.length !== ids.length) return c.json({ error: "document_not_found" }, 404);
    const mergeDocs = (await loadMergeDocs(db)).filter((d) => ids.includes(d.id));
    const primaryId = body?.primaryDocumentId ?? pickPrimary(mergeDocs.map((d) => ({ id: d.id, kind: d.kind, date: d.date })))!.id;
    const created = await createObject(
      db,
      primaryId,
      actor,
      ids.filter((i) => i !== primaryId).map((documentId) => ({ documentId, role: body?.roles?.[documentId] ?? null, itemLineNo: body?.itemLineNos?.[documentId] ?? null })),
    );
    return c.json({ ok: true, created: true, ...created }, 201);
  } catch (err) {
    return objectErrorResponse(c, err);
  }
});

// 全部品項(列表「全部展開」用);?purchaseIds=A,B 只取指定物件(最多 50)。
purchasesRoute.get("/items", async (c) => {
  const db = createDb(c.env.DB);
  const raw = c.req.query("purchaseIds");
  const ids = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50) : null;
  const rows = ids
    ? await db.select().from(purchaseItems).where(inArray(purchaseItems.purchaseId, ids))
    : await db.select().from(purchaseItems);
  return c.json({ items: rows.sort((a, b) => a.purchaseId.localeCompare(b.purchaseId) || a.lineNo - b.lineNo) });
});

// 2026-09-16「彈性標籤項目」模型補上 documentLinks(比照 assets.ts 的 GET /:id)——一筆採購案
// 可能是從同一份來源文件拆出來的好幾個獨立項目之一(見 schema.ts 的 documentPurchaseLinks
// 註解),詳情頁要看得到「這筆項目連回了哪些文件」,不能只看得到採購案自己的欄位。
purchasesRoute.get("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const [row] = await db.select().from(purchases).where(eq(purchases.id, id)).limit(1);
  if (!row) return c.json({ error: "not_found" }, 404);
  const tags = await db.select().from(purchaseTags).where(eq(purchaseTags.purchaseId, id));

  const links = await db
    .select({
      documentId: documentPurchaseLinks.documentId,
      relationKind: documentPurchaseLinks.relationKind,
      docTypeCode: documents.docTypeCode,
      vendorNameRaw: documents.vendorNameRaw,
      status: documents.status,
    })
    .from(documentPurchaseLinks)
    .innerJoin(documents, eq(documents.id, documentPurchaseLinks.documentId))
    .where(eq(documentPurchaseLinks.purchaseId, id));

  // 2026-09-29:物件詳情(主文件/附件/品項/非單據附件/旗標)。
  const object = await getObjectDetail(db, id);
  return c.json({ purchase: row, tags: tags.map((t) => t.tag), documentLinks: links, object });
});

// 文件加入物件/改角色/改掛品項。role 不給:發票接手主文件(物件目前主文件不是發票時),其餘依文件種類。
purchasesRoute.post("/:id/documents", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{ documentId?: string; role?: string | null; itemId?: string | null }>().catch(() => null);
  if (!body?.documentId) return c.json({ error: "missing_document_id" }, 400);
  try {
    const result = await attachDocument(createDb(c.env.DB), c.req.param("id"), body.documentId, {
      role: body.role ?? null,
      itemId: body.itemId,
      actor: actorOf(auth),
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    return objectErrorResponse(c, err);
  }
});

// 從物件移出文件(恢復成獨立文件);移出主文件時由剩下的文件接手,最後一份移出時物件解散。
purchasesRoute.post("/:id/documents/:documentId/remove", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  try {
    const result = await detachDocument(createDb(c.env.DB), c.req.param("id"), c.req.param("documentId"), actorOf(auth));
    return c.json({ ok: true, ...result });
  } catch (err) {
    return objectErrorResponse(c, err);
  }
});

// 手動新增品項。
purchasesRoute.post("/:id/items", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const body = await c.req.json<ItemBody>().catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);
  const db = createDb(c.env.DB);
  const [purchase] = await db.select().from(purchases).where(eq(purchases.id, id)).limit(1);
  if (!purchase) return c.json({ error: "not_found" }, 404);
  const parsed = parseItemBody(body, false);
  if ("field" in parsed) return c.json({ error: "invalid_field", field: parsed.field }, 400);
  const existing = await db.select({ lineNo: purchaseItems.lineNo }).from(purchaseItems).where(eq(purchaseItems.purchaseId, id));
  const itemId = await nextId(db, "PIT", Number(purchase.purchaseDate.slice(0, 4)) || new Date().getFullYear());
  await db.batch([
    db.insert(purchaseItems).values({
      ...(parsed.patch as typeof purchaseItems.$inferInsert),
      id: itemId,
      purchaseId: id,
      lineNo: existing.reduce((m, r) => Math.max(m, r.lineNo), 0) + 1,
      source: "manual",
    }),
    db.insert(activityLog).values({
      entityType: "purchase",
      entityId: id,
      kind: "review",
      text: `${auth.name ?? auth.email ?? "系統"} 新增品項 ${itemId}「${parsed.patch.name}」`,
      actorMemberId: auth.memberId,
    }),
  ]);
  return c.json({ ok: true, id: itemId }, 201);
});

// 非單據附件(開箱影片、照片):只記 NAS 路徑,原檔不上傳(沿用「原始檔只留 NAS」)。
purchasesRoute.post("/:id/attachments", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const body = await c.req
    .json<{ kind?: string; localPath?: string; itemId?: string | null; originalFileName?: string; mimeType?: string; byteSize?: number; sha256?: string; note?: string }>()
    .catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);
  if (!["video", "photo", "other"].includes(body.kind ?? "")) return c.json({ error: "invalid_field", field: "kind" }, 400);
  const pathErr = validateLocalPath(body.localPath, { allowOutside: true });
  if (pathErr) return c.json({ error: "invalid_field", field: "localPath", message: pathErr }, 400);
  if (body.sha256 && !/^[0-9a-f]{64}$/.test(body.sha256)) return c.json({ error: "invalid_field", field: "sha256" }, 400);
  const db = createDb(c.env.DB);
  const [purchase] = await db.select().from(purchases).where(eq(purchases.id, id)).limit(1);
  if (!purchase) return c.json({ error: "not_found" }, 404);
  if (body.itemId) {
    const [item] = await db.select().from(purchaseItems).where(eq(purchaseItems.id, body.itemId)).limit(1);
    if (!item || item.purchaseId !== id) return c.json({ error: "invalid_field", field: "itemId" }, 400);
  }
  const [row] = await db
    .insert(purchaseAttachments)
    .values({
      purchaseId: id,
      purchaseItemId: body.itemId ?? null,
      kind: body.kind!,
      localPath: body.localPath!,
      originalFileName: body.originalFileName ?? body.localPath!.split("/").pop() ?? null,
      mimeType: body.mimeType ?? null,
      byteSize: Number.isInteger(body.byteSize) ? body.byteSize! : null,
      sha256: body.sha256 ?? null,
      note: body.note?.slice(0, 500) ?? null,
      createdByMemberId: auth.memberId,
    })
    .returning({ id: purchaseAttachments.id });
  await db.insert(activityLog).values({
    entityType: "purchase",
    entityId: id,
    kind: "review",
    text: `${auth.name ?? auth.email ?? "系統"} 加入${body.kind === "video" ? "影片" : body.kind === "photo" ? "照片" : "附件"}:${body.localPath}(NAS 改名待 archive.py 計畫確認)`,
    actorMemberId: auth.memberId,
  });
  return c.json({ ok: true, id: row.id }, 201);
});

purchasesRoute.post("/", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{
    ownership: string;
    purchaseDate: string;
    vendorId?: string;
    vendorNameRaw: string;
    summary: string;
    subNote?: string;
    amountCents: number;
    currency?: string;
    categoryId?: string;
    accountType?: string;
    payerKind?: string;
    payer?: string;
    reimbursementStatus?: string;
    warrantyEndDate?: string;
    orderNo?: string;
    invoiceNo?: string;
    tags?: string[];
    // 2026-09-13 財務文件自動分類新增,跟 ownership 正交(見 schema.ts entities 註解)——
    // Review 畫面可能會帶入 Gemini 建議值(document_extracted_fields 的 entity_id/
    // project_id),也可以由人工直接選擇/留空。
    entityId?: string;
    projectId?: string;
    // 2026-09-16「彈性標籤項目」模型新增(比照 assets.ts 既有的 linkDocumentId)——選填,
    // 建立當下順便連結一份既有文件。一張發票列了好幾樣不同的東西時,同一個 documentId
    // 可以連續呼叫這支端點好幾次、每次帶不同的 summary/tags,拆成好幾筆各自獨立的採購案,
    // 全部連回同一份來源文件,不會互相覆蓋——document_purchase_links 本來就是多對多。
    linkDocumentId?: string;
  }>();

  const db = createDb(c.env.DB);
  // 2026-09-29(CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md):物件 = 一筆消費,一份文件最多屬於一個物件。
  // 原本「同一份文件拆成好幾筆採購案」(2026-09-16 彈性項目)改成在物件裡拆品項(POST /:id/items、/api/purchase-items/:id/split)。
  if (body.linkDocumentId) {
    const [inObject] = await db
      .select({ purchaseId: documentPurchaseLinks.purchaseId })
      .from(documentPurchaseLinks)
      .where(and(eq(documentPurchaseLinks.documentId, body.linkDocumentId), ne(documentPurchaseLinks.relationKind, "duplicate_evidence")))
      .limit(1);
    if (inObject) {
      return c.json({ error: "already_in_object", message: `${body.linkDocumentId} 已經屬於物件 ${inObject.purchaseId},請在物件裡新增品項`, purchaseId: inObject.purchaseId }, 409);
    }
  }
  const year = new Date(body.purchaseDate).getFullYear();
  const id = await nextId(db, "PUR", year);

  await db.insert(purchases).values({
    id,
    ownership: body.ownership,
    purchaseDate: body.purchaseDate,
    vendorId: body.vendorId ?? null,
    vendorNameRaw: body.vendorNameRaw,
    summary: body.summary,
    subNote: body.subNote ?? null,
    amountCents: body.amountCents,
    currency: body.currency ?? "TWD",
    categoryId: body.categoryId ?? null,
    accountType: body.accountType ?? null,
    payerKind: body.payerKind ?? "company",
    payer: body.payer ?? null,
    reimbursementStatus: body.reimbursementStatus ?? "not_applicable",
    warrantyEndDate: body.warrantyEndDate ?? null,
    orderNo: body.orderNo ?? null,
    invoiceNo: body.invoiceNo ?? null,
    entityId: body.entityId ?? null,
    projectId: body.projectId ?? null,
    status: "archived",
    createdByMemberId: auth.memberId,
  });

  if (body.tags?.length) {
    await db.insert(purchaseTags).values(body.tags.map((tag) => ({ purchaseId: id, tag })));
  }

  if (body.linkDocumentId) {
    await db.insert(documentPurchaseLinks).values({
      documentId: body.linkDocumentId,
      purchaseId: id,
      relationKind: "primary",
      linkedBy: "manual",
      createdByMemberId: auth.memberId,
    });
  }

  return c.json({ ok: true, id }, 201);
});

// 編輯採購案(2026-09-08 補完 CODE_TASK_fix-panel-and-editable_20260908.md 任務 3)——
// 欄位比照既有的資料模型(跟 POST / 建立時能填的那組一致),不管這筆是文件流程產生還是
// 手動建立都能編輯。權限/驗證邏輯跟其他寫入操作一致(canWrite)。
purchasesRoute.post("/:id", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const id = c.req.param("id");
  const body = await c.req.json<{
    ownership?: string;
    purchaseDate?: string;
    vendorId?: string;
    vendorNameRaw?: string;
    summary?: string;
    subNote?: string;
    amountCents?: number;
    currency?: string;
    categoryId?: string;
    accountType?: string;
    payerKind?: string;
    payer?: string;
    warrantyEndDate?: string;
    orderNo?: string;
    invoiceNo?: string;
    status?: string;
    entityId?: string;
    projectId?: string;
  }>();

  const db = createDb(c.env.DB);
  const [existing] = await db.select().from(purchases).where(eq(purchases.id, id)).limit(1);
  if (!existing) return c.json({ error: "not_found" }, 404);

  await db
    .update(purchases)
    .set({
      ownership: body.ownership ?? existing.ownership,
      purchaseDate: body.purchaseDate ?? existing.purchaseDate,
      vendorId: body.vendorId !== undefined ? body.vendorId || null : existing.vendorId,
      vendorNameRaw: body.vendorNameRaw ?? existing.vendorNameRaw,
      summary: body.summary ?? existing.summary,
      subNote: body.subNote !== undefined ? body.subNote || null : existing.subNote,
      amountCents: body.amountCents ?? existing.amountCents,
      currency: body.currency ?? existing.currency,
      categoryId: body.categoryId !== undefined ? body.categoryId || null : existing.categoryId,
      accountType: body.accountType !== undefined ? body.accountType || null : existing.accountType,
      payerKind: body.payerKind ?? existing.payerKind,
      payer: body.payer !== undefined ? body.payer || null : existing.payer,
      warrantyEndDate: body.warrantyEndDate !== undefined ? body.warrantyEndDate || null : existing.warrantyEndDate,
      orderNo: body.orderNo !== undefined ? body.orderNo || null : existing.orderNo,
      invoiceNo: body.invoiceNo !== undefined ? body.invoiceNo || null : existing.invoiceNo,
      entityId: body.entityId !== undefined ? body.entityId || null : existing.entityId,
      projectId: body.projectId !== undefined ? body.projectId || null : existing.projectId,
      status: body.status ?? existing.status,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(purchases.id, id));

  return c.json({ ok: true });
});

// 修改代墊/請款狀態 —— 覆核畫面或會計後續更新用,獨立端點避免整包 PATCH 誤改其他欄位。
purchasesRoute.post("/:id/reimbursement-status", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const id = c.req.param("id");
  const body = await c.req.json<{ reimbursementStatus: string }>();
  const db = createDb(c.env.DB);

  await db
    .update(purchases)
    .set({ reimbursementStatus: body.reimbursementStatus, updatedAt: new Date().toISOString() })
    .where(eq(purchases.id, id));

  return c.json({ ok: true });
});
