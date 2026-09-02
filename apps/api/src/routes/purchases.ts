// 採購案 —— 規格 2.3、3.2(清單頁「依購買案」view)。

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
    payer?: string;
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
    payer: body.payer ?? null,
    warrantyEndDate: body.warrantyEndDate ?? null,
    orderNo: body.orderNo ?? null,
    invoiceNo: body.invoiceNo ?? null,
    status: "archived",
  });

  if (body.tags?.length) {
    await db.insert(purchaseTags).values(body.tags.map((tag) => ({ purchaseId: id, tag })));
  }

  return c.json({ ok: true, id }, 201);
});
