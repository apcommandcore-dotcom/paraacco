// 資產 —— 規格 2.4、3.2(清單頁「依資產」view)。v2:新增 createdByMemberId。

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { assets, createDb, nextId } from "@paraacco/db";
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
