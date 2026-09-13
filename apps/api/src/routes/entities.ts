// 法律主體 —— 2026-09-13 財務文件自動分類新增(見 packages/db/src/schema.ts entities 註解)。
// 只有唯讀端點:目前只有 2 筆,人工在 D1 維護(migrations-manual/0002_entities_seed.sql),
// 不需要管理介面能新增/編輯,前端(範圍切換器、篩選條件)只需要讀清單。

import { Hono } from "hono";
import { createDb, entities } from "@paraacco/db";
import type { Bindings } from "../bindings";

export const entitiesRoute = new Hono<{ Bindings: Bindings }>();

entitiesRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.select().from(entities);
  return c.json({ entities: rows });
});
