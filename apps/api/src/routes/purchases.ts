// 採購案 —— 規格 2.3、3.2(清單頁「依購買案」view)。
// v2:新增 payerKind(代墊人身分,對應範圍決策——這裡算的是「代墊」項目,見 schema.ts 開頭
// 註解)、reimbursementStatus 較完整的狀態集合、createdByMemberId 記錄是哪個成員(會計／
// 負責人)建立這筆紀錄。

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { createDb, nextId, purchases, purchaseTags } from "@paraacco/db";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";

export const purchasesRoute = new Hono<{ Bindings: Bindings }>();

// ownership 篩選 —— 2026-09-07 補完設計落差任務書任務 2(範圍切換器),沿用既有的
// ownership 欄位(per/corp/advance/custody),不是新欄位。
purchasesRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const status = c.req.query("status");
  const ownership = c.req.query("ownership");
  const conditions = [status ? eq(purchases.status, status) : undefined, ownership ? eq(purchases.ownership, ownership) : undefined].filter(
    (v) => v !== undefined,
  );
  const rows = conditions.length
    ? await db
        .select()
        .from(purchases)
        .where(and(...conditions))
        .orderBy(desc(purchases.purchaseDate))
    : await db.select().from(purchases).orderBy(desc(purchases.purchaseDate));
  return c.json({ purchases: rows });
});

purchasesRoute.get("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const [row] = await db.select().from(purchases).where(eq(purchases.id, id)).limit(1);
  if (!row) return c.json({ error: "not_found" }, 404);
  const tags = await db.select().from(purchaseTags).where(eq(purchaseTags.purchaseId, id));
  return c.json({ purchase: row, tags: tags.map((t) => t.tag) });
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
  }>();

  const db = createDb(c.env.DB);
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
