// 保固與訂閱 —— 2026-09-07 補完設計落差任務書任務 3。狀態(使用中/即將到期/已過期)不落地
// 存欄位,GET 回傳時用 @paraacco/domain 的 computeWarrantyStatus() 即時算,見
// packages/domain/src/warranty-status.ts 開頭註解。
//
// 2026-09-26(migration 0008):擴充成「保固、訂閱與定期繳費」——新增 type='recurring_bill'、
// category/paymentMethod/accountRef 三個欄位、bimonthly/semiannual 週期,寫入前先驗證列舉值
// (原本沒驗證,不合法的值會一路打到 D1 被 CHECK 擋成 500),另加 POST /:id/advance「已繳,排
// 下一期」。

import { Hono } from "hono";
import { and, asc, eq, isNotNull, ne } from "drizzle-orm";
import {
  advanceDueDate,
  computeWarrantyStatus,
  PAYMENT_METHODS,
  RENEWAL_CYCLES,
  WARRANTY_CATEGORIES,
  WARRANTY_TYPES,
  type RenewalCycle,
} from "@paraacco/domain";
import { activityLog, createDb, nextId, purchaseItems, purchases, warrantySubscriptions } from "@paraacco/db";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";

export const warrantyRoute = new Hono<{ Bindings: Bindings }>();

warrantyRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const ownership = c.req.query("ownership");
  const includeLegacy = c.req.query("includeLegacyRecurring") === "1";
  const conditions = [
    ownership ? eq(warrantySubscriptions.ownership, ownership) : undefined,
    includeLegacy ? undefined : ne(warrantySubscriptions.type, "recurring_bill"),
  ].filter((v) => v !== undefined);
  const rows = await db
    .select()
    .from(warrantySubscriptions)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(warrantySubscriptions.endDate));

  // 2026-09-29(CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md 2.5、5.1):保固記在品項上——有保固迄日的品項
  // 也列在「保固與訂閱」頁(唯讀,點回物件編輯)。歸屬用品項歸屬,沒改過就跟物件(發票)。
  const itemRows = await db
    .select({ item: purchaseItems, purchaseOwnership: purchases.ownership, vendorNameRaw: purchases.vendorNameRaw })
    .from(purchaseItems)
    .innerJoin(purchases, eq(purchases.id, purchaseItems.purchaseId))
    .where(isNotNull(purchaseItems.warrantyEndDate));
  const itemWarranties = itemRows
    .map(({ item, purchaseOwnership, vendorNameRaw }) => ({
      itemId: item.id,
      purchaseId: item.purchaseId,
      name: item.name,
      brand: item.brand,
      model: item.model,
      serialNo: item.serialNo,
      vendorName: vendorNameRaw,
      ownership: item.ownership ?? purchaseOwnership,
      startDate: item.warrantyStartDate,
      endDate: item.warrantyEndDate!,
      status: computeWarrantyStatus({ endDate: item.warrantyEndDate!, reminderDaysBefore: 30 }),
    }))
    .filter((w) => !ownership || w.ownership === ownership)
    .sort((a, b) => a.endDate.localeCompare(b.endDate));

  return c.json({
    items: rows.map((row) => ({
      ...row,
      status: computeWarrantyStatus({ endDate: row.endDate, reminderDaysBefore: row.reminderDaysBefore }),
    })),
    itemWarranties,
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
  category?: string | null;
  vendorName?: string;
  startDate?: string;
  endDate: string;
  renewalCycle?: string;
  amountCents?: number | null;
  paymentMethod?: string | null;
  accountRef?: string | null;
  currency?: string;
  reminderDaysBefore?: number;
  note?: string;
}

const OWNERSHIP_VALUES = ["per", "corp", "advance", "custody"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 回傳第一個不合法的欄位名稱;全部合法回傳 null。partial=true 時未提供的欄位不檢查(更新用)。 */
function invalidField(body: Partial<WarrantyBody>, partial: boolean): string | null {
  const has = (k: keyof WarrantyBody) => body[k] !== undefined;
  if ((!partial || has("type")) && !(WARRANTY_TYPES as readonly string[]).includes(body.type ?? "")) return "type";
  if ((!partial || has("ownership")) && !(OWNERSHIP_VALUES as readonly string[]).includes(body.ownership ?? "")) return "ownership";
  if ((!partial || has("name")) && !(body.name ?? "").trim()) return "name";
  if ((!partial || has("endDate")) && !DATE_RE.test(body.endDate ?? "")) return "endDate";
  if (has("startDate") && body.startDate && !DATE_RE.test(body.startDate)) return "startDate";
  if (has("renewalCycle") && !(RENEWAL_CYCLES as readonly string[]).includes(body.renewalCycle ?? "")) return "renewalCycle";
  if (has("category") && body.category !== null && body.category !== "" && !(WARRANTY_CATEGORIES as readonly string[]).includes(body.category ?? "")) return "category";
  if (has("paymentMethod") && body.paymentMethod !== null && body.paymentMethod !== "" && !(PAYMENT_METHODS as readonly string[]).includes(body.paymentMethod ?? "")) return "paymentMethod";
  if (has("amountCents") && body.amountCents !== null && (typeof body.amountCents !== "number" || !Number.isInteger(body.amountCents) || body.amountCents < 0)) return "amountCents";
  return null;
}

warrantyRoute.post("/", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<WarrantyBody>();
  const bad = invalidField(body, false);
  if (bad) return c.json({ error: "invalid_field", field: bad }, 400);
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
    category: body.category || null,
    vendorName: body.vendorName ?? null,
    startDate: body.startDate ?? null,
    endDate: body.endDate,
    renewalCycle: body.renewalCycle ?? "one_time",
    amountCents: body.amountCents ?? null,
    paymentMethod: body.paymentMethod || null,
    accountRef: body.accountRef?.trim() || null,
    currency: body.currency ?? "TWD",
    reminderDaysBefore: body.reminderDaysBefore ?? 30,
    note: body.note ?? null,
    createdByMemberId: auth.memberId,
  });

  await db.insert(activityLog).values({
    entityType: "warranty_subscription",
    entityId: id,
    kind: "import",
    text: `${auth.name ?? auth.email ?? "系統"} 新增保固/訂閱/定期繳費:${body.name}`,
    actorMemberId: auth.memberId,
  });

  return c.json({ ok: true, id }, 201);
});

warrantyRoute.post("/:id", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const id = c.req.param("id");
  const body = await c.req.json<Partial<WarrantyBody>>();
  const bad = invalidField(body, true);
  if (bad) return c.json({ error: "invalid_field", field: bad }, 400);
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
      category: body.category !== undefined ? body.category || null : existing.category,
      vendorName: body.vendorName !== undefined ? body.vendorName || null : existing.vendorName,
      startDate: body.startDate !== undefined ? body.startDate || null : existing.startDate,
      endDate: body.endDate ?? existing.endDate,
      renewalCycle: body.renewalCycle ?? existing.renewalCycle,
      amountCents: body.amountCents !== undefined ? body.amountCents : existing.amountCents,
      paymentMethod: body.paymentMethod !== undefined ? body.paymentMethod || null : existing.paymentMethod,
      accountRef: body.accountRef !== undefined ? body.accountRef?.trim() || null : existing.accountRef,
      currency: body.currency ?? existing.currency,
      reminderDaysBefore: body.reminderDaysBefore ?? existing.reminderDaysBefore,
      note: body.note !== undefined ? body.note || null : existing.note,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(warrantySubscriptions.id, id));

  return c.json({ ok: true });
});

// 定期繳費/訂閱「已繳,排下一期」:end_date 依 renewal_cycle 往後推一期(月底日夾到短月份
// 最後一天,見 advanceDueDate),寫 activity_log。one_time 沒有下一期,回 409。
// 可帶 { amountCents } 更新本期實繳金額(水電瓦斯每期金額不同),不帶則維持原值。
warrantyRoute.post("/:id/advance", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const id = c.req.param("id");
  const body = await c.req.json<{ amountCents?: number | null }>().catch(() => ({}) as { amountCents?: number | null });
  if (body.amountCents !== undefined && body.amountCents !== null && (!Number.isInteger(body.amountCents) || body.amountCents < 0)) {
    return c.json({ error: "invalid_field", field: "amountCents" }, 400);
  }
  const db = createDb(c.env.DB);
  const [existing] = await db.select().from(warrantySubscriptions).where(eq(warrantySubscriptions.id, id)).limit(1);
  if (!existing) return c.json({ error: "not_found" }, 404);

  const next = advanceDueDate(existing.endDate, existing.renewalCycle as RenewalCycle);
  if (!next) return c.json({ error: "no_next_cycle", message: "一次性項目沒有下一期" }, 409);

  await db
    .update(warrantySubscriptions)
    .set({
      endDate: next,
      amountCents: body.amountCents !== undefined ? body.amountCents : existing.amountCents,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(warrantySubscriptions.id, id));

  await db.insert(activityLog).values({
    entityType: "warranty_subscription",
    entityId: id,
    kind: "review",
    text: `${auth.name ?? auth.email ?? "系統"} 標記已繳:${existing.name} ${existing.endDate} → 下一期 ${next}`,
    actorMemberId: auth.memberId,
  });

  return c.json({ ok: true, previousEndDate: existing.endDate, endDate: next });
});

warrantyRoute.post("/:id/delete", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const id = c.req.param("id");
  const db = createDb(c.env.DB);
  await db.delete(warrantySubscriptions).where(eq(warrantySubscriptions.id, id));
  return c.json({ ok: true });
});
