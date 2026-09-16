// 供應商主檔 —— 規格 2.6、3.7-2(管理後台「供應商主檔」頁籤 + 新增供應商表單)。

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createDb, vendors, vendorAliases } from "@paraacco/db";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";

export const vendorsRoute = new Hono<{ Bindings: Bindings }>();

// categoryId 篩選 —— 2026-09-16「依標題瀏覽」入口新增(架構文件:分類→供應商兩層瀏覽,
// 見 paraacco-browse-by-title-design-evaluation-20260916.md 第 1 節)。
vendorsRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const categoryId = c.req.query("categoryId");
  const rows = categoryId
    ? await db.select().from(vendors).where(eq(vendors.defaultCategoryId, categoryId))
    : await db.select().from(vendors);
  const aliasRows = await db.select().from(vendorAliases);
  const withAliases = rows.map((v) => ({
    ...v,
    aliases: aliasRows.filter((a) => a.vendorId === v.id).map((a) => a.alias),
  }));
  return c.json({ vendors: withAliases });
});

vendorsRoute.post("/", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{
    id: string;
    name: string;
    taxId?: string;
    defaultOwnership: string;
    defaultCategoryId?: string;
    aliases?: string[];
  }>();

  const db = createDb(c.env.DB);
  await db.insert(vendors).values({
    id: body.id,
    name: body.name,
    taxId: body.taxId ?? null,
    defaultOwnership: body.defaultOwnership,
    defaultCategoryId: body.defaultCategoryId ?? null,
  });

  if (body.aliases?.length) {
    await db.insert(vendorAliases).values(body.aliases.map((alias) => ({ vendorId: body.id, alias })));
  }

  return c.json({ ok: true, id: body.id }, 201);
});

vendorsRoute.get("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const [row] = await db.select().from(vendors).where(eq(vendors.id, id)).limit(1);
  if (!row) return c.json({ error: "not_found" }, 404);
  const aliasRows = await db.select().from(vendorAliases).where(eq(vendorAliases.vendorId, id));
  return c.json({ vendor: row, aliases: aliasRows.map((a) => a.alias) });
});
