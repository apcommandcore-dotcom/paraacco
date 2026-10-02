// 品項類別 / 自動規則 / 代墊請款對象(2026-10-01,CODE_TASK_purchase-object-merge-docs_20260929_V1.02.md 7.3、7.4)——
// 管理後台「品項類別」頁用。一律在後台維護,不寫死在程式。
//   /api/item-categories   GET(?active=1 只列啟用)、POST 新增、POST /:id 修改(改名/停用/子類別/會計科目…)、
//                          POST /:id/delete(只能刪沒被用過的;用過的只能停用)、POST /reorder { ids: [...] }
//   /api/item-rules        GET、POST 新增、POST /:id { isActive }、POST /:id/delete(刪規則不改動已套用的品項)
//   /api/advance-payees    GET、POST 新增、POST /:id 修改/停用

import { Hono } from "hono";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  activityLog,
  advancePayees,
  createDb,
  itemCategories,
  itemRules,
  purchaseItems,
} from "@paraacco/db";
import {
  isValidTaxId,
  ITEM_OWNERSHIPS,
  normalizeTaxId,
} from "@paraacco/domain";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";

const optText = (v: unknown, max = 100) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const PROJECT_RE = /^AP_\d{5}$/;

// ---------------------------------------------------------------------------
export const itemCategoriesRoute = new Hono<{ Bindings: Bindings }>();

itemCategoriesRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db
    .select()
    .from(itemCategories)
    .orderBy(asc(itemCategories.sortOrder), asc(itemCategories.id));
  const used = await db.all<{ category_id: string; n: number }>(
    sql`SELECT category_id, COUNT(*) AS n FROM purchase_items WHERE category_id IS NOT NULL GROUP BY category_id`,
  );
  const usedBy = new Map(used.map((u) => [u.category_id, u.n]));
  const list = rows.map((r) => ({ ...r, usedCount: usedBy.get(r.id) ?? 0 }));
  return c.json({
    categories:
      c.req.query("active") === "1" ? list.filter((r) => r.isActive) : list,
  });
});

interface CategoryBody {
  name?: unknown;
  code?: unknown;
  parentId?: unknown;
  accountTitle?: unknown;
  defaultOwnership?: unknown;
  isActive?: unknown;
  color?: unknown;
}

async function validateCategory(
  db: ReturnType<typeof createDb>,
  body: CategoryBody,
  selfId?: string,
): Promise<string | null> {
  if (body.name !== undefined && !optText(body.name)) return "name";
  if (
    body.defaultOwnership !== undefined &&
    body.defaultOwnership !== null &&
    body.defaultOwnership !== "" &&
    !(ITEM_OWNERSHIPS as readonly unknown[]).includes(body.defaultOwnership)
  )
    return "defaultOwnership";
  if (body.parentId) {
    if (typeof body.parentId !== "string" || body.parentId === selfId)
      return "parentId";
    const [parent] = await db
      .select()
      .from(itemCategories)
      .where(eq(itemCategories.id, body.parentId))
      .limit(1);
    // 只做一層子類別:父類別本身不能是子類別
    if (!parent || parent.parentId) return "parentId";
    if (selfId) {
      const [child] = await db
        .select({ id: itemCategories.id })
        .from(itemCategories)
        .where(eq(itemCategories.parentId, selfId))
        .limit(1);
      if (child) return "parentId";
    }
  }
  return null;
}

itemCategoriesRoute.post("/", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<CategoryBody>().catch(() => null);
  if (!body || !optText(body.name))
    return c.json({ error: "invalid_field", field: "name" }, 400);
  const db = createDb(c.env.DB);
  const bad = await validateCategory(db, body);
  if (bad) return c.json({ error: "invalid_field", field: bad }, 400);
  const rows = await db
    .select({ id: itemCategories.id, sortOrder: itemCategories.sortOrder })
    .from(itemCategories);
  const max = rows.reduce(
    (m, r) => Math.max(m, Number(/^ICT-(\d+)$/.exec(r.id)?.[1] ?? 0)),
    0,
  );
  const id = `ICT-${String(max + 1).padStart(3, "0")}`;
  await db.insert(itemCategories).values({
    id,
    name: optText(body.name)!,
    code: optText(body.code, 30),
    parentId: optText(body.parentId),
    accountTitle: optText(body.accountTitle),
    defaultOwnership: optText(body.defaultOwnership),
    color: optText(body.color, 20),
    sortOrder: rows.reduce((m, r) => Math.max(m, r.sortOrder), 0) + 10,
  });
  return c.json({ ok: true, id }, 201);
});

itemCategoriesRoute.post("/reorder", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
  const ids = Array.isArray(body?.ids)
    ? (body!.ids as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  if (!ids.length) return c.json({ error: "missing_ids" }, 400);
  const db = createDb(c.env.DB);
  await db.batch(
    ids.map((id, i) =>
      db
        .update(itemCategories)
        .set({ sortOrder: (i + 1) * 10 })
        .where(eq(itemCategories.id, id)),
    ) as unknown as Parameters<typeof db.batch>[0],
  );
  return c.json({ ok: true });
});

itemCategoriesRoute.post("/:id", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const body = await c.req.json<CategoryBody>().catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);
  const db = createDb(c.env.DB);
  const [cur] = await db
    .select()
    .from(itemCategories)
    .where(eq(itemCategories.id, id))
    .limit(1);
  if (!cur) return c.json({ error: "not_found" }, 404);
  const bad = await validateCategory(db, body, id);
  if (bad) return c.json({ error: "invalid_field", field: bad }, 400);
  if (body.isActive !== undefined && typeof body.isActive !== "boolean")
    return c.json({ error: "invalid_field", field: "isActive" }, 400);
  const patch: Partial<typeof itemCategories.$inferInsert> = {};
  if (body.name !== undefined) patch.name = optText(body.name)!;
  if (body.code !== undefined) patch.code = optText(body.code, 30);
  if (body.parentId !== undefined) patch.parentId = optText(body.parentId);
  if (body.accountTitle !== undefined)
    patch.accountTitle = optText(body.accountTitle);
  if (body.defaultOwnership !== undefined)
    patch.defaultOwnership = optText(body.defaultOwnership);
  if (body.color !== undefined) patch.color = optText(body.color, 20);
  if (body.isActive !== undefined) patch.isActive = body.isActive as boolean;
  if (!Object.keys(patch).length) return c.json({ ok: true, unchanged: true });
  await db.batch([
    db.update(itemCategories).set(patch).where(eq(itemCategories.id, id)),
    db.insert(activityLog).values({
      entityType: "item_category",
      entityId: id,
      kind: "review",
      text: `${auth.name ?? auth.email ?? "系統"} 修改品項類別「${cur.name}」:${Object.keys(patch).join("、")}`,
      actorMemberId: auth.memberId,
    }),
  ]);
  return c.json({ ok: true });
});

itemCategoriesRoute.post("/:id/delete", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const db = createDb(c.env.DB);
  const [used] = await db
    .select({ id: purchaseItems.id })
    .from(purchaseItems)
    .where(eq(purchaseItems.categoryId, id))
    .limit(1);
  if (used)
    return c.json(
      {
        error: "category_in_use",
        message: "這個類別已經被品項使用,只能停用不能刪除",
      },
      409,
    );
  const [child] = await db
    .select({ id: itemCategories.id })
    .from(itemCategories)
    .where(eq(itemCategories.parentId, id))
    .limit(1);
  if (child)
    return c.json(
      { error: "has_children", message: "請先移除或改掛子類別" },
      409,
    );
  const [rule] = await db
    .select({ id: itemRules.id })
    .from(itemRules)
    .where(eq(itemRules.categoryId, id))
    .limit(1);
  if (rule)
    return c.json(
      {
        error: "category_in_rule",
        message: "這個類別被自動規則使用,請先停用或刪除規則",
      },
      409,
    );
  await db.delete(itemCategories).where(eq(itemCategories.id, id));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
export const itemRulesRoute = new Hono<{ Bindings: Bindings }>();

itemRulesRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  return c.json({
    rules: await db.select().from(itemRules).orderBy(desc(itemRules.id)),
  });
});

itemRulesRoute.post("/", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req
    .json<{
      vendorTaxId?: string;
      nameKeyword?: string | null;
      categoryId?: string | null;
      ownership?: string | null;
      projectCode?: string | null;
    }>()
    .catch(() => null);
  const r = await createItemRule(createDb(c.env.DB), body ?? {}, auth.memberId);
  return "error" in r ? c.json(r, 400) : c.json(r, 201);
});

export async function createItemRule(
  db: ReturnType<typeof createDb>,
  body: {
    vendorTaxId?: string | null;
    nameKeyword?: string | null;
    categoryId?: string | null;
    ownership?: string | null;
    projectCode?: string | null;
  },
  memberId: string | null,
): Promise<{ ok: true; id: number } | { error: string; field?: string }> {
  const tax = body.vendorTaxId ? normalizeTaxId(body.vendorTaxId) : "";
  if (!isValidTaxId(tax))
    return { error: "invalid_field", field: "vendorTaxId" };
  if (!body.categoryId && !body.ownership && !body.projectCode)
    return { error: "empty_rule" };
  if (
    body.ownership &&
    !(ITEM_OWNERSHIPS as readonly string[]).includes(body.ownership)
  )
    return { error: "invalid_field", field: "ownership" };
  if (body.projectCode && !PROJECT_RE.test(body.projectCode))
    return { error: "invalid_field", field: "projectCode" };
  if (body.categoryId) {
    const [cat] = await db
      .select()
      .from(itemCategories)
      .where(
        and(
          eq(itemCategories.id, body.categoryId),
          eq(itemCategories.isActive, true),
        ),
      )
      .limit(1);
    if (!cat) return { error: "invalid_field", field: "categoryId" };
  }
  const [row] = await db
    .insert(itemRules)
    .values({
      vendorTaxId: tax,
      nameKeyword: optText(body.nameKeyword),
      categoryId: body.categoryId ?? null,
      ownership: body.ownership ?? null,
      projectCode: body.projectCode ?? null,
      createdByMemberId: memberId,
    })
    .returning({ id: itemRules.id });
  return { ok: true, id: row.id };
}

itemRulesRoute.post("/:id", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{ isActive?: unknown }>().catch(() => null);
  if (typeof body?.isActive !== "boolean")
    return c.json({ error: "invalid_field", field: "isActive" }, 400);
  await createDb(c.env.DB)
    .update(itemRules)
    .set({ isActive: body.isActive })
    .where(eq(itemRules.id, Number(c.req.param("id"))));
  return c.json({ ok: true });
});

itemRulesRoute.post("/:id/delete", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  // 刪規則不改動已套用的品項(那些品項的 category_source 仍是 rule,覆核頁照樣可以改回)。
  await createDb(c.env.DB)
    .delete(itemRules)
    .where(eq(itemRules.id, Number(c.req.param("id"))));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
export const advancePayeesRoute = new Hono<{ Bindings: Bindings }>();

advancePayeesRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db
    .select()
    .from(advancePayees)
    .orderBy(asc(advancePayees.sortOrder));
  return c.json({
    payees:
      c.req.query("active") === "1" ? rows.filter((r) => r.isActive) : rows,
  });
});

advancePayeesRoute.post("/", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{ name?: unknown }>().catch(() => null);
  const name = optText(body?.name, 50);
  if (!name) return c.json({ error: "invalid_field", field: "name" }, 400);
  const db = createDb(c.env.DB);
  const rows = await db.select().from(advancePayees);
  const id = `payee-${crypto.randomUUID().slice(0, 8)}`;
  await db
    .insert(advancePayees)
    .values({
      id,
      name,
      sortOrder: rows.reduce((m, r) => Math.max(m, r.sortOrder), 0) + 10,
    });
  return c.json({ ok: true, id }, 201);
});

advancePayeesRoute.post("/:id", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req
    .json<{ name?: unknown; isActive?: unknown }>()
    .catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);
  const patch: Partial<typeof advancePayees.$inferInsert> = {};
  if (body.name !== undefined) {
    const n = optText(body.name, 50);
    if (!n) return c.json({ error: "invalid_field", field: "name" }, 400);
    patch.name = n;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean")
      return c.json({ error: "invalid_field", field: "isActive" }, 400);
    patch.isActive = body.isActive;
  }
  await createDb(c.env.DB)
    .update(advancePayees)
    .set(patch)
    .where(eq(advancePayees.id, c.req.param("id")));
  return c.json({ ok: true });
});
