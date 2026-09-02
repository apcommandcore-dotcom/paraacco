// 採購案 —— 規格 2.3、3.2(清單頁「依購買案」view)。
// v2:新增 payerKind(代墊人身分,對應範圍決策——這裡算的是「代墊」項目,見 schema.ts 開頭
// 註解)、reimbursementStatus 較完整的狀態集合、createdByMemberId 記錄是哪個成員(會計／
// 負責人)建立這筆紀錄。

import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { createDb, nextId, purchases, purchaseTags } from "@paraacco/db";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";

export const purchasesRoute = new Hono<{ Bindings: Bindings }>();

purchasesRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const status = c.req.query("status");
  const rows = status
    ? await db.select().from(purchases).where(eq(purchases.status, status)).orderBy(desc(purchases.purchaseDate))
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
    status: "archived",
    createdByMemberId: auth.memberId,
  });

  if (body.tags?.length) {
    await db.insert(purchaseTags).values(body.tags.map((tag) => ({ purchaseId: id, tag })));
  }

  return c.json({ ok: true, id }, 201);
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
