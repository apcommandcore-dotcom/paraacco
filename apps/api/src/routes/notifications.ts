// 通知中心 —— 2026-09-07 補完設計落差任務書任務 5。這支路由只處理「人類讀取/標記已讀」,
// 通知的「產生」邏輯在 scheduled.ts(排程)跟各個事件觸發點(見 notify.ts 的
// createNotification() 共用寫入函式),不是這裡。

import { Hono } from "hono";
import { desc, eq, isNull, sql } from "drizzle-orm";
import { createDb, notifications } from "@paraacco/db";
import type { Bindings } from "../bindings";

export const notificationsRoute = new Hono<{ Bindings: Bindings }>();

notificationsRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const limit = Number(c.req.query("limit") ?? "30");
  const rows = await db.select().from(notifications).orderBy(desc(notifications.createdAt)).limit(limit);
  const [unreadRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(notifications)
    .where(isNull(notifications.readAt));

  return c.json({ notifications: rows, unreadCount: unreadRow?.n ?? 0 });
});

notificationsRoute.post("/:id/read", async (c) => {
  const db = createDb(c.env.DB);
  const id = Number(c.req.param("id"));
  await db.update(notifications).set({ readAt: new Date().toISOString() }).where(eq(notifications.id, id));
  return c.json({ ok: true });
});

notificationsRoute.post("/read-all", async (c) => {
  const db = createDb(c.env.DB);
  await db.update(notifications).set({ readAt: new Date().toISOString() }).where(isNull(notifications.readAt));
  return c.json({ ok: true });
});
