// 近期動態 / 稽核日誌查詢 —— 規格 2.10、3.1(dashboard 側欄)。

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { activityLog, createDb } from "@paraacco/db";
import type { Bindings } from "../bindings";

export const activityRoute = new Hono<{ Bindings: Bindings }>();

activityRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const entityType = c.req.query("entityType");
  const entityId = c.req.query("entityId");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);

  const rows =
    entityType && entityId
      ? await db
          .select()
          .from(activityLog)
          .where(and(eq(activityLog.entityType, entityType), eq(activityLog.entityId, entityId)))
          .orderBy(desc(activityLog.createdAt))
          .limit(limit)
      : await db.select().from(activityLog).orderBy(desc(activityLog.createdAt)).limit(limit);

  return c.json({ activity: rows });
});
