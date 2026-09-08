// 保固與訂閱 —— 2026-09-07 補完設計落差任務書任務 3。狀態(使用中/即將到期/已過期)不落地
// 存欄位,GET 回傳時用 @paraacco/domain 的 computeWarrantyStatus() 即時算,見
// packages/domain/src/warranty-status.ts 開頭註解。

import { Hono } from "hono";
import { and, asc, eq } from "drizzle-orm";
import { computeWarrantyStatus } from "@paraacco/domain";
import { activityLog, createDb, nextId, warrantySubscriptions } from "@paraacco/db";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";

export const warrantyRoute = new Hono<{ Bindings: Bindings }>();

warrantyRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const ownership = c.req.query("ownership");
  const rows = ownership
    ? await db.select().from(warrantySubscriptions).where(eq(warrantySubscriptions.ownership, ownership)).orderBy(asc(warrantySubscriptions.endDate))
    : await db.select().from(warrantySubscriptions).orderBy(asc(warrantySubscriptions.endDate));

  return c.json({
    items: rows.map((row) => ({
      ...row,
      status: computeWarrantyStatus({ endDate: row.endDate, reminderDaysBefore: row.reminderDaysBefore }),
    })),
  });
});

warrantyRoute.get("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const [row] = await db.select().from(warrantySubscriptions).where(eq(warrantySubscriptions.id, c.req.param("id"))).limit(1);
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ item: { ...row, status: computeWarrantyStatus({ endDate: row.endDate, reminderDaysBefore: row.reminderDaysBefore }) } });
});

interface WarrantyBody {
  entityType?: string;
  entityId?: string;
  ownership: string;
  name: string;
  type: string;
  vendorName?: string;
  startDate?: string;
  endDate: string;
  renewalCycle?: string;
  amountCents?: number;
  currency?: string;
  reminderDaysBefore?: number;
  note?: string;
}

warrantyRoute.post("/", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<WarrantyBody>();
  const db = createDb(c.env.DB);
  const year = new Date().getFullYear();
  const id = await nextId(db, "WSU", year);

  await db.insert(warrantySubscriptions).values({
    id,
    entityType: body.entityType ?? null,
    entityId: body.entityId ?? null,
    ownership: body.ownership,
    name: body.name,
    type: body.type,
    vendorName: body.vendorName ?? null,
    startDate: body.startDate ?? null,
    endDate: body.endDate,
    renewalCycle: body.renewalCycle ?? "one_time",
    amountCents: body.amountCents ?? null,
    currency: body.currency ?? "TWD",
    reminderDaysBefore: body.reminderDaysBefore ?? 30,
    note: body.note ?? null,
    createdByMemberId: auth.memberId,
  });

  await db.insert(activityLog).values({
    entityType: "warranty_subscription",
    entityId: id,
    kind: "import",
    text: `${auth.name ?? auth.email ?? "系統"} 新增保固/訂閱:${body.name}`,
    actorMemberId: auth.memberId,
  });

  return c.json({ ok: true, id }, 201);
});

warrantyRoute.post("/:id", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const id = c.req.param("id");
  const body = await c.req.json<Partial<WarrantyBody>>();
  const db = createDb(c.env.DB);

  const [existing] = await db.select().from(warrantySubscriptions).where(eq(warrantySubscriptions.id, id)).limit(1);
  if (!existing) return c.json({ error: "not_found" }, 404);

  await db
    .update(warrantySubscriptions)
    .set({
      entityType: body.entityType !== undefined ? body.entityType || null : existing.entityType,
      entityId: body.entityId !== undefined ? body.entityId || null : existing.entityId,
      ownership: body.ownership ?? existing.ownership,
      name: body.name ?? existing.name,
      type: body.type ?? existing.type,
      vendorName: body.vendorName !== undefined ? body.vendorName || null : existing.vendorName,
      startDate: body.startDate !== undefined ? body.startDate || null : existing.startDate,
      endDate: body.endDate ?? existing.endDate,
      renewalCycle: body.renewalCycle ?? existing.renewalCycle,
      amountCents: body.amountCents !== undefined ? body.amountCents : existing.amountCents,
      currency: body.currency ?? existing.currency,
      reminderDaysBefore: body.reminderDaysBefore ?? existing.reminderDaysBefore,
      note: body.note !== undefined ? body.note || null : existing.note,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(warrantySubscriptions.id, id));

  return c.json({ ok: true });
});

warrantyRoute.post("/:id/delete", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const id = c.req.param("id");
  const db = createDb(c.env.DB);
  await db.delete(warrantySubscriptions).where(eq(warrantySubscriptions.id, id));
  return c.json({ ok: true });
});
