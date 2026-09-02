// 資產 —— 規格 2.4、3.2(清單頁「依資產」view)。v2:新增 createdByMemberId。

import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { assets, createDb, nextId } from "@paraacco/db";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";

export const assetsRoute = new Hono<{ Bindings: Bindings }>();

assetsRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const status = c.req.query("status");
  const rows = status
    ? await db.select().from(assets).where(eq(assets.status, status)).orderBy(desc(assets.acquiredDate))
    : await db.select().from(assets).orderBy(desc(assets.acquiredDate));
  return c.json({ assets: rows });
});

assetsRoute.get("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const [row] = await db.select().from(assets).where(eq(assets.id, c.req.param("id"))).limit(1);
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ asset: row });
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
    status: "active",
    createdByMemberId: auth.memberId,
  });

  return c.json({ ok: true, id }, 201);
});
