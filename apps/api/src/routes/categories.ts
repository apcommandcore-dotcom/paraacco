// 分類樹 —— 規格 2.2、3.7-3(管理後台「分類樹與檔名模板」頁籤)。parentId 自我參照做樹狀
// 結構,跟 vendors 一樣沒有走 nextId 流水號,id 由呼叫端決定(見 admin 頁面前端怎麼組 id)。

import { Hono } from "hono";
import { categories, createDb } from "@paraacco/db";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";

export const categoriesRoute = new Hono<{ Bindings: Bindings }>();

categoriesRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.select().from(categories);
  return c.json({ categories: rows });
});

categoriesRoute.post("/", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{ id: string; ownershipScope: string; parentId?: string; name: string }>();

  const db = createDb(c.env.DB);
  await db.insert(categories).values({
    id: body.id,
    ownershipScope: body.ownershipScope,
    parentId: body.parentId ?? null,
    name: body.name,
  });

  return c.json({ ok: true, id: body.id }, 201);
});
