// 資產 —— 規格 2.4、3.2(清單頁「依資產」view)。v2:新增 createdByMemberId。

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { activityLog, assets, createDb, documentAssetLinks, documents, nextId, warrantySubscriptions } from "@paraacco/db";
import { computeWarrantyStatus } from "@paraacco/domain";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";

export const assetsRoute = new Hono<{ Bindings: Bindings }>();

// ownership 篩選 —— 2026-09-07 補完設計落差任務書任務 2(範圍切換器),沿用既有的
// ownership 欄位(per/corp/advance/custody),不是新欄位。
assetsRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const status = c.req.query("status");
  const ownership = c.req.query("ownership");
  const conditions = [status ? eq(assets.status, status) : undefined, ownership ? eq(assets.ownership, ownership) : undefined].filter(
    (v) => v !== undefined,
  );
  const rows = conditions.length
    ? await db
        .select()
        .from(assets)
        .where(and(...conditions))
        .orderBy(desc(assets.acquiredDate))
    : await db.select().from(assets).orderBy(desc(assets.acquiredDate));
  return c.json({ assets: rows });
});

// 2026-09-08 補完設計落差任務書任務 2(手動新增資產)—— 詳情頁順便帶回關聯文件清單,
// 讓「事後補連結一份電子發票/收據掃描檔」這個選填流程,使用者在詳情頁看得到已經連了什麼。
assetsRoute.get("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const [row] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  if (!row) return c.json({ error: "not_found" }, 404);

  const links = await db
    .select({
      documentId: documentAssetLinks.documentId,
      relationKind: documentAssetLinks.relationKind,
      docTypeCode: documents.docTypeCode,
      vendorNameRaw: documents.vendorNameRaw,
      status: documents.status,
    })
    .from(documentAssetLinks)
    .innerJoin(documents, eq(documents.id, documentAssetLinks.documentId))
    .where(eq(documentAssetLinks.assetId, id));

  // 保固狀態(2026-09-10 資產欄位對齊任務書任務 2)—— 不在 assets 表另存一份,直接查掛在
  // 這筆資產上的保固/訂閱紀錄(entityType='asset'),用跟「保固與訂閱」畫面同一個
  // computeWarrantyStatus() 算,不重寫一套邏輯。一筆資產可能掛多筆保固/訂閱紀錄,挑「最
  // 需要使用者注意」的一筆顯示:即將到期優先於使用中優先於已過期,同優先度取到期日較近的。
  const warrantyRows = await db
    .select()
    .from(warrantySubscriptions)
    .where(and(eq(warrantySubscriptions.entityType, "asset"), eq(warrantySubscriptions.entityId, id)));

  const statusPriority: Record<string, number> = { due_soon: 0, active: 1, expired: 2 };
  const warrantyWithStatus = warrantyRows
    .map((w) => ({ ...w, status: computeWarrantyStatus({ endDate: w.endDate, reminderDaysBefore: w.reminderDaysBefore }) }))
    .sort((a, b) => statusPriority[a.status] - statusPriority[b.status] || a.endDate.localeCompare(b.endDate));

  return c.json({ asset: row, documentLinks: links, warranty: warrantyWithStatus[0] ?? null });
});

assetsRoute.post("/", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{
    ownership: string;
    name: string;
    categoryId?: string;
    brand?: string;
    model?: string;
    serialNo?: string;
    acquiredDate?: string;
    holderEntity?: string;
    keeper?: string;
    location?: string;
    warrantyEndDate?: string;
    purchaseId?: string;
    vendorName?: string;
    amountCents?: number;
    currency?: string;
    note?: string;
    // 選填:建立當下順便關聯一份既有文件(見 POST /:id/link-document 的說明)。
    linkDocumentId?: string;
  }>();

  const db = createDb(c.env.DB);
  const year = new Date(body.acquiredDate ?? Date.now()).getFullYear();
  const id = await nextId(db, "AST", year);

  await db.insert(assets).values({
    id,
    ownership: body.ownership,
    name: body.name,
    categoryId: body.categoryId ?? null,
    brand: body.brand ?? null,
    model: body.model ?? null,
    serialNo: body.serialNo ?? null,
    acquiredDate: body.acquiredDate ?? null,
    holderEntity: body.holderEntity ?? null,
    keeper: body.keeper ?? null,
    location: body.location ?? null,
    warrantyEndDate: body.warrantyEndDate ?? null,
    purchaseId: body.purchaseId ?? null,
    vendorName: body.vendorName ?? null,
    amountCents: body.amountCents ?? null,
    currency: body.currency ?? "TWD",
    note: body.note ?? null,
    status: "active",
    createdByMemberId: auth.memberId,
  });

  await db.insert(activityLog).values({
    entityType: "asset",
    entityId: id,
    kind: "import",
    text: `${auth.name ?? auth.email ?? "系統"} 手動新增資產:${body.name}`,
    actorMemberId: auth.memberId,
  });

  if (body.linkDocumentId) {
    await db.insert(documentAssetLinks).values({
      documentId: body.linkDocumentId,
      assetId: id,
      relationKind: "supporting",
      linkedBy: "manual",
      createdByMemberId: auth.memberId,
    });
  }

  return c.json({ ok: true, id }, 201);
});

// 編輯資產(2026-09-08 補完 CODE_TASK_fix-panel-and-editable_20260908.md 任務 3)——
// 不管這筆資產原本是文件流程產生的還是手動建立的,都能編輯,欄位比照 POST / 建立時能填的
// 那組。權限/驗證邏輯跟其他寫入操作一致(canWrite)。
assetsRoute.post("/:id", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const id = c.req.param("id");
  const body = await c.req.json<{
    ownership?: string;
    name?: string;
    categoryId?: string;
    brand?: string;
    model?: string;
    serialNo?: string;
    acquiredDate?: string;
    holderEntity?: string;
    keeper?: string;
    location?: string;
    warrantyEndDate?: string;
    vendorName?: string;
    amountCents?: number;
    currency?: string;
    note?: string;
    status?: string;
  }>();

  const db = createDb(c.env.DB);
  const [existing] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  if (!existing) return c.json({ error: "not_found" }, 404);

  await db
    .update(assets)
    .set({
      ownership: body.ownership ?? existing.ownership,
      name: body.name ?? existing.name,
      categoryId: body.categoryId !== undefined ? body.categoryId || null : existing.categoryId,
      brand: body.brand !== undefined ? body.brand || null : existing.brand,
      model: body.model !== undefined ? body.model || null : existing.model,
      serialNo: body.serialNo !== undefined ? body.serialNo || null : existing.serialNo,
      acquiredDate: body.acquiredDate !== undefined ? body.acquiredDate || null : existing.acquiredDate,
      holderEntity: body.holderEntity !== undefined ? body.holderEntity || null : existing.holderEntity,
      keeper: body.keeper !== undefined ? body.keeper || null : existing.keeper,
      location: body.location !== undefined ? body.location || null : existing.location,
      warrantyEndDate: body.warrantyEndDate !== undefined ? body.warrantyEndDate || null : existing.warrantyEndDate,
      vendorName: body.vendorName !== undefined ? body.vendorName || null : existing.vendorName,
      amountCents: body.amountCents !== undefined ? body.amountCents : existing.amountCents,
      currency: body.currency ?? existing.currency,
      note: body.note !== undefined ? body.note || null : existing.note,
      status: body.status ?? existing.status,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(assets.id, id));

  await db.insert(activityLog).values({
    entityType: "asset",
    entityId: id,
    kind: "review",
    text: `${auth.name ?? auth.email ?? "系統"} 編輯資產資料`,
    actorMemberId: auth.memberId,
  });

  return c.json({ ok: true });
});

// 事後補連結一份既有文件(規格見任務書:「之後有補電子發票或收據掃描檔,可以事後補連結,
// 不強制」)。刻意不重用 routes/documents.ts 的 POST /:id/link——那支端點是待覆核工作台
// 「決定這份文件關聯到誰」的流程,有副作用(把其餘 pending 候選標成 superseded、文件狀態
// 改成 archived),語意是「文件視角、正在決定歸屬」;這裡是「資產視角、事後補一份佐證
// 文件」,不該連動改文件狀態或動到候選紀錄,所以是獨立、更單純的一支端點。
assetsRoute.post("/:id/link-document", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const id = c.req.param("id");
  // relationKind 選填(2026-09-10 資產欄位對齊任務書任務 3)—— 預設 'supporting'(維持原本
  // 行為,既有呼叫端不用改),說明書連結傳 'manual'(schema 本來就允許這個值,不用改
  // CHECK constraint)。'manual' 這裡指「文件角色是說明書」,跟 linkedBy='manual'(指「這筆
  // 關聯是人工建立的,不是系統自動比對」)是兩個不同語意的欄位,不要混淆。
  const body = await c.req.json<{ documentId: string; relationKind?: string }>();
  const db = createDb(c.env.DB);

  const [asset] = await db.select({ id: assets.id }).from(assets).where(eq(assets.id, id)).limit(1);
  if (!asset) return c.json({ error: "not_found" }, 404);
  const [doc] = await db.select({ id: documents.id }).from(documents).where(eq(documents.id, body.documentId)).limit(1);
  if (!doc) return c.json({ error: "document_not_found" }, 404);

  await db.insert(documentAssetLinks).values({
    documentId: body.documentId,
    assetId: id,
    relationKind: body.relationKind ?? "supporting",
    linkedBy: "manual",
    createdByMemberId: auth.memberId,
  });

  await db.insert(activityLog).values({
    entityType: "asset",
    entityId: id,
    kind: "review",
    text: `${auth.name ?? auth.email ?? "系統"} 補連結文件 ${body.documentId}`,
    actorMemberId: auth.memberId,
  });

  return c.json({ ok: true });
});
