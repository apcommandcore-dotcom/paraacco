// 購買品項與物件附件(2026-09-29,CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md 第五節)——人類使用者端。
//
//   POST /api/purchase-items/:id                      修改品項(品名/數量/單價/小計/品牌/型號/序號/歸屬/保固起訖/備註)
//   POST /api/purchase-items/:id/delete               刪除品項(掛在上面的文件/附件改回物件層)
//   POST /api/purchase-items/:id/split                拆分 { quantities: [1, 1] }(例:數量 2 拆成兩個品項,各掛各的序號與保固)
//   POST /api/purchase-items/attachments/:attId        非單據附件改掛品項 { itemId | null }
//   POST /api/purchase-items/attachments/:attId/delete 刪除非單據附件紀錄(NAS 原檔不動)
//
// 2026-10-01(CODE_TASK_purchase-object-merge-docs_20260929_V1.02.md 第七節)品項右鍵選單:
//   POST /api/purchase-items/bulk      { itemIds, set: {...}, rememberRule?: { nameKeyword? } } 一次套用到多個品項;
//                                      寫 item_change_batches(Undo 用)與 activity_log
//   POST /api/purchase-items/undo      { batchId? } 復原最近一次(或指定的一次)右鍵套用
//   GET  /api/purchase-items/recent-categories   最近手動用過的類別(選單「最近使用」置頂)
//   GET  /api/purchase-items/advances?settled=0|1|all  代墊品項清單(對帳頁「未請回」)
//   POST /api/purchase-items/:id/reset-rule      規則自動帶入的類別一鍵改回(清空)
//   POST /api/purchase-items/:id/asset           由品項建立資產(品名/品牌/型號/序號/保固/金額帶入)
//
// 品項歸屬預設跟發票(ownership = null);逐項改歸屬只影響月報表公司/個人小計的拆分,物件金額仍是發票總額。

import { Hono } from "hono";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  activityLog,
  advancePayees,
  assets,
  createDb,
  documentExtractedFields,
  documentPurchaseLinks,
  itemCategories,
  itemChangeBatches,
  nextId,
  purchaseAttachments,
  purchaseItems,
  purchases,
} from "@paraacco/db";
import {
  ITEM_OWNERSHIPS,
  resolveVendorTaxId,
  splitItem,
} from "@paraacco/domain";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";
import { itemInsertStatements } from "../purchase-objects";
import { createItemRule } from "./item-admin";

export const purchaseItemsRoute = new Hono<{ Bindings: Bindings }>();

export interface ItemBody {
  name?: unknown;
  quantity?: unknown;
  unitPriceCents?: unknown;
  amountCents?: unknown;
  brand?: unknown;
  model?: unknown;
  serialNo?: unknown;
  ownership?: unknown;
  warrantyStartDate?: unknown;
  warrantyEndDate?: unknown;
  note?: unknown;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const optText = (v: unknown, max = 200) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

/** 驗證品項欄位。partial=true(修改)時沒給的不動。 */
export function parseItemBody(
  body: ItemBody,
  partial: boolean,
): { patch: Partial<typeof purchaseItems.$inferInsert> } | { field: string } {
  const has = (k: keyof ItemBody) => body[k] !== undefined;
  const patch: Partial<typeof purchaseItems.$inferInsert> = {};
  if (!partial || has("name")) {
    if (typeof body.name !== "string" || !body.name.trim())
      return { field: "name" };
    patch.name = body.name.trim().slice(0, 200);
  }
  if (!partial || has("amountCents")) {
    if (
      typeof body.amountCents !== "number" ||
      !Number.isInteger(body.amountCents)
    )
      return { field: "amountCents" };
    patch.amountCents = body.amountCents;
  }
  if (has("quantity")) {
    if (typeof body.quantity !== "number" || !(body.quantity > 0))
      return { field: "quantity" };
    patch.quantity = body.quantity;
  }
  if (has("unitPriceCents")) {
    if (
      body.unitPriceCents !== null &&
      (typeof body.unitPriceCents !== "number" ||
        !Number.isInteger(body.unitPriceCents))
    )
      return { field: "unitPriceCents" };
    patch.unitPriceCents = body.unitPriceCents as number | null;
  }
  if (has("ownership")) {
    if (
      body.ownership !== null &&
      body.ownership !== "" &&
      !(ITEM_OWNERSHIPS as readonly unknown[]).includes(body.ownership)
    )
      return { field: "ownership" };
    patch.ownership = optText(body.ownership);
  }
  for (const k of ["warrantyStartDate", "warrantyEndDate"] as const) {
    if (!has(k)) continue;
    if (
      body[k] !== null &&
      body[k] !== "" &&
      !(typeof body[k] === "string" && DATE_RE.test(body[k] as string))
    )
      return { field: k };
    patch[k] = optText(body[k]);
  }
  if (has("brand")) patch.brand = optText(body.brand, 100);
  if (has("model")) patch.model = optText(body.model, 100);
  if (has("serialNo")) patch.serialNo = optText(body.serialNo, 100);
  if (has("note")) patch.note = optText(body.note, 500);
  return { patch };
}

purchaseItemsRoute.post("/attachments/:attId", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const attId = Number(c.req.param("attId"));
  const body = await c.req.json<{ itemId?: string | null }>().catch(() => null);
  if (!body || body.itemId === undefined)
    return c.json({ error: "missing_item_id" }, 400);
  const db = createDb(c.env.DB);
  const [att] = await db
    .select()
    .from(purchaseAttachments)
    .where(eq(purchaseAttachments.id, attId))
    .limit(1);
  if (!att) return c.json({ error: "not_found" }, 404);
  if (body.itemId) {
    const [item] = await db
      .select()
      .from(purchaseItems)
      .where(eq(purchaseItems.id, body.itemId))
      .limit(1);
    if (!item || item.purchaseId !== att.purchaseId)
      return c.json({ error: "invalid_field", field: "itemId" }, 400);
  }
  await db
    .update(purchaseAttachments)
    .set({ purchaseItemId: body.itemId ?? null })
    .where(eq(purchaseAttachments.id, attId));
  return c.json({ ok: true });
});

purchaseItemsRoute.post("/attachments/:attId/delete", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const attId = Number(c.req.param("attId"));
  const db = createDb(c.env.DB);
  const [att] = await db
    .select()
    .from(purchaseAttachments)
    .where(eq(purchaseAttachments.id, attId))
    .limit(1);
  if (!att) return c.json({ error: "not_found" }, 404);
  await db.batch([
    db.delete(purchaseAttachments).where(eq(purchaseAttachments.id, attId)),
    db.insert(activityLog).values({
      entityType: "purchase",
      entityId: att.purchaseId,
      kind: "review",
      text: `${auth.name ?? auth.email ?? "系統"} 移除附件紀錄 ${att.localPath}(NAS 原檔不動)`,
      actorMemberId: auth.memberId,
    }),
  ]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 品項右鍵選單(V1.02 7.2)
// ---------------------------------------------------------------------------

/** 右鍵可套用的欄位;值 null = 清空。name 只能單選時改(修正品名,原始辨識品名留在 name_original)。 */
interface BulkSet {
  categoryId?: string | null;
  ownership?: string | null;
  projectCode?: string | null;
  isAdvance?: boolean;
  advancePayee?: string | null;
  advanceSettled?: boolean;
  excludeFromReport?: boolean;
  excludeReason?: string | null;
  name?: string;
  warrantyStartDate?: string | null;
  warrantyEndDate?: string | null;
}

/** item_change_batches.before 記的欄位(Undo 時原樣寫回)。 */
const UNDO_FIELDS = [
  "categoryId",
  "categorySource",
  "ownership",
  "projectCode",
  "isAdvance",
  "advancePayee",
  "advanceSettledAt",
  "excludeFromReport",
  "excludeReason",
  "name",
  "nameOriginal",
  "warrantyStartDate",
  "warrantyEndDate",
] as const;
type UndoField = (typeof UNDO_FIELDS)[number];
type ItemRow = typeof purchaseItems.$inferSelect;

const PROJECT_RE = /^AP_\d{5}$/;

async function parseBulkSet(
  db: ReturnType<typeof createDb>,
  set: BulkSet,
  single: boolean,
): Promise<{ field: string } | { ok: true }> {
  if (set.categoryId) {
    const [cat] = await db
      .select()
      .from(itemCategories)
      .where(
        and(
          eq(itemCategories.id, set.categoryId),
          eq(itemCategories.isActive, true),
        ),
      )
      .limit(1);
    if (!cat) return { field: "categoryId" };
  }
  if (
    set.ownership &&
    !(ITEM_OWNERSHIPS as readonly string[]).includes(set.ownership)
  )
    return { field: "ownership" };
  if (set.projectCode && !PROJECT_RE.test(set.projectCode))
    return { field: "projectCode" };
  for (const k of [
    "isAdvance",
    "advanceSettled",
    "excludeFromReport",
  ] as const) {
    if (set[k] !== undefined && typeof set[k] !== "boolean")
      return { field: k };
  }
  if (set.advancePayee) {
    const [p] = await db
      .select()
      .from(advancePayees)
      .where(
        and(
          eq(advancePayees.id, set.advancePayee),
          eq(advancePayees.isActive, true),
        ),
      )
      .limit(1);
    if (!p) return { field: "advancePayee" };
  }
  if (set.isAdvance === true && !set.advancePayee)
    return { field: "advancePayee" };
  if (set.excludeFromReport === true && !optText(set.excludeReason))
    return { field: "excludeReason" };
  if (
    set.name !== undefined &&
    (!single || typeof set.name !== "string" || !set.name.trim())
  )
    return { field: "name" };
  for (const k of ["warrantyStartDate", "warrantyEndDate"] as const) {
    const v = set[k];
    if (
      v !== undefined &&
      v !== null &&
      v !== "" &&
      !(typeof v === "string" && DATE_RE.test(v))
    )
      return { field: k };
  }
  return { ok: true };
}

/** 把 BulkSet 轉成單一品項的 patch(name_original 只在第一次改名時記;不列帳取消時清掉原因)。 */
function patchFor(
  item: ItemRow,
  set: BulkSet,
  now: string,
): Partial<typeof purchaseItems.$inferInsert> {
  const patch: Partial<typeof purchaseItems.$inferInsert> = {};
  if (set.categoryId !== undefined) {
    patch.categoryId = set.categoryId || null;
    patch.categorySource = set.categoryId ? "manual" : null;
  }
  if (set.ownership !== undefined) patch.ownership = set.ownership || null;
  if (set.projectCode !== undefined)
    patch.projectCode = set.projectCode || null;
  if (set.isAdvance !== undefined) {
    patch.isAdvance = set.isAdvance;
    patch.advancePayee = set.isAdvance
      ? (set.advancePayee ?? item.advancePayee)
      : null;
    if (!set.isAdvance) patch.advanceSettledAt = null;
  } else if (set.advancePayee !== undefined)
    patch.advancePayee = set.advancePayee || null;
  if (set.advanceSettled !== undefined)
    patch.advanceSettledAt = set.advanceSettled ? now : null;
  if (set.excludeFromReport !== undefined) {
    patch.excludeFromReport = set.excludeFromReport;
    patch.excludeReason = set.excludeFromReport
      ? optText(set.excludeReason, 200)
      : null;
  }
  if (set.name !== undefined) {
    const name = set.name.trim().slice(0, 200);
    if (name !== item.name) {
      patch.name = name;
      if (!item.nameOriginal) patch.nameOriginal = item.name;
    }
  }
  if (set.warrantyStartDate !== undefined)
    patch.warrantyStartDate = set.warrantyStartDate || null;
  if (set.warrantyEndDate !== undefined)
    patch.warrantyEndDate = set.warrantyEndDate || null;
  return patch;
}

const SET_LABELS: Record<string, string> = {
  categoryId: "類別",
  ownership: "歸屬",
  projectCode: "專案",
  isAdvance: "代墊",
  advancePayee: "請款對象",
  advanceSettled: "已請回",
  excludeFromReport: "不列帳",
  excludeReason: "不列帳原因",
  name: "品名",
  warrantyStartDate: "保固起",
  warrantyEndDate: "保固迄",
};

purchaseItemsRoute.post("/bulk", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req
    .json<{
      itemIds?: unknown;
      set?: BulkSet;
      rememberRule?: { nameKeyword?: string | null };
    }>()
    .catch(() => null);
  const itemIds = Array.isArray(body?.itemIds)
    ? [
        ...new Set(
          (body!.itemIds as unknown[]).filter(
            (x): x is string => typeof x === "string",
          ),
        ),
      ]
    : [];
  if (!itemIds.length || itemIds.length > 200)
    return c.json({ error: "invalid_field", field: "itemIds" }, 400);
  const set = body?.set ?? {};
  if (!Object.keys(set).length) return c.json({ error: "empty_set" }, 400);
  const db = createDb(c.env.DB);
  const parsed = await parseBulkSet(db, set, itemIds.length === 1);
  if ("field" in parsed)
    return c.json({ error: "invalid_field", field: parsed.field }, 400);
  const items = await db
    .select()
    .from(purchaseItems)
    .where(inArray(purchaseItems.id, itemIds));
  if (items.length !== itemIds.length)
    return c.json(
      {
        error: "not_found",
        missing: itemIds.filter((id) => !items.some((i) => i.id === id)),
      },
      404,
    );

  const now = new Date().toISOString();
  const before: Record<string, Partial<Record<UndoField, unknown>>> = {};
  const statements: unknown[] = [];
  for (const item of items) {
    const patch = patchFor(item, set, now);
    if (!Object.keys(patch).length) continue;
    before[item.id] = Object.fromEntries(
      UNDO_FIELDS.filter((k) => k in patch).map((k) => [k, item[k]]),
    );
    statements.push(
      db
        .update(purchaseItems)
        .set({ ...patch, updatedAt: now })
        .where(eq(purchaseItems.id, item.id)),
    );
  }
  const changed = Object.keys(before);
  let batchId: number | null = null;
  if (statements.length) {
    const [batch] = await db
      .insert(itemChangeBatches)
      .values({
        itemIds: JSON.stringify(changed),
        changes: JSON.stringify(set),
        before: JSON.stringify(before),
        actorMemberId: auth.memberId,
      })
      .returning({ id: itemChangeBatches.id });
    const label = Object.keys(set)
      .map((k) => SET_LABELS[k] ?? k)
      .join("、");
    const actor = auth.name ?? auth.email ?? "系統";
    for (const purchaseId of new Set(
      items.filter((i) => changed.includes(i.id)).map((i) => i.purchaseId),
    )) {
      const ids = items
        .filter((i) => i.purchaseId === purchaseId && changed.includes(i.id))
        .map((i) => i.id);
      statements.push(
        db.insert(activityLog).values({
          entityType: "purchase",
          entityId: purchaseId,
          kind: "review",
          text: `${actor} 品項右鍵套用(批次 #${batch.id})${label}:${ids.join("、")}`,
          actorMemberId: auth.memberId,
        }),
      );
    }
    await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
    batchId = batch.id;
  }

  // 「記住此規則」(值沒變也照建規則):用第一個品項所屬物件主文件的賣方統編(+ 選填品名關鍵字)建自動規則,之後同店家新品項自動帶入。
  let ruleId: number | null = null;
  let ruleError: string | null = null;
  if (body?.rememberRule) {
    const taxId = await primaryTaxIdOf(db, items[0].purchaseId);
    const r = await createItemRule(
      db,
      {
        vendorTaxId: taxId,
        nameKeyword: body.rememberRule.nameKeyword ?? null,
        categoryId: set.categoryId ?? null,
        ownership: set.ownership ?? null,
        projectCode: set.projectCode ?? null,
      },
      auth.memberId,
    );
    if ("error" in r) ruleError = r.field ?? r.error;
    else ruleId = r.id;
  }
  return c.json({
    ok: true,
    batchId,
    changed: changed.length,
    unchanged: !changed.length,
    ruleId,
    ruleError,
  });
});

async function primaryTaxIdOf(
  db: ReturnType<typeof createDb>,
  purchaseId: string,
): Promise<string | null> {
  const [link] = await db
    .select({ documentId: documentPurchaseLinks.documentId })
    .from(documentPurchaseLinks)
    .where(
      and(
        eq(documentPurchaseLinks.purchaseId, purchaseId),
        eq(documentPurchaseLinks.relationKind, "primary"),
      ),
    )
    .limit(1);
  if (!link) return null;
  const fields = await db
    .select({
      k: documentExtractedFields.fieldKey,
      v: documentExtractedFields.value,
    })
    .from(documentExtractedFields)
    .where(
      and(
        eq(documentExtractedFields.documentId, link.documentId),
        inArray(documentExtractedFields.fieldKey, [
          "vendorTaxIdQr",
          "vendorTaxIdPrinted",
          "vendorTaxId",
        ]),
      ),
    );
  const f = new Map(fields.map((x) => [x.k, x.v]));
  return resolveVendorTaxId({
    qr: f.get("vendorTaxIdQr"),
    printed: f.get("vendorTaxIdPrinted"),
    legacy: f.get("vendorTaxId"),
  }).taxId;
}

purchaseItemsRoute.post("/undo", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req
    .json<{ batchId?: number }>()
    .catch(() => ({}) as { batchId?: number });
  const db = createDb(c.env.DB);
  const [batch] = body.batchId
    ? await db
        .select()
        .from(itemChangeBatches)
        .where(eq(itemChangeBatches.id, Number(body.batchId)))
        .limit(1)
    : await db
        .select()
        .from(itemChangeBatches)
        .where(isNull(itemChangeBatches.undoneAt))
        .orderBy(desc(itemChangeBatches.id))
        .limit(1);
  if (!batch) return c.json({ error: "nothing_to_undo" }, 404);
  if (batch.undoneAt) return c.json({ error: "already_undone" }, 409);
  const before = JSON.parse(batch.before) as Record<
    string,
    Partial<Record<UndoField, unknown>>
  >;
  const now = new Date().toISOString();
  const items = await db
    .select({ id: purchaseItems.id, purchaseId: purchaseItems.purchaseId })
    .from(purchaseItems)
    .where(inArray(purchaseItems.id, Object.keys(before)));
  const statements: unknown[] = items.map((i) =>
    db
      .update(purchaseItems)
      .set({
        ...(before[i.id] as Partial<typeof purchaseItems.$inferInsert>),
        updatedAt: now,
      })
      .where(eq(purchaseItems.id, i.id)),
  );
  statements.push(
    db
      .update(itemChangeBatches)
      .set({ undoneAt: now })
      .where(eq(itemChangeBatches.id, batch.id)),
  );
  for (const purchaseId of new Set(items.map((i) => i.purchaseId))) {
    statements.push(
      db.insert(activityLog).values({
        entityType: "purchase",
        entityId: purchaseId,
        kind: "review",
        text: `${auth.name ?? auth.email ?? "系統"} 復原品項右鍵套用(批次 #${batch.id})`,
        actorMemberId: auth.memberId,
      }),
    );
  }
  await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
  return c.json({ ok: true, batchId: batch.id, restored: items.length });
});

purchaseItemsRoute.get("/recent-categories", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.all<{ category_id: string }>(
    sql`SELECT category_id FROM purchase_items WHERE category_id IS NOT NULL AND category_source = 'manual' GROUP BY category_id ORDER BY MAX(updated_at) DESC LIMIT 5`,
  );
  return c.json({ categoryIds: rows.map((r) => r.category_id) });
});

purchaseItemsRoute.get("/advances", async (c) => {
  const settled = c.req.query("settled") ?? "0";
  const db = createDb(c.env.DB);
  const rows = await db
    .select({
      item: purchaseItems,
      purchaseDate: purchases.purchaseDate,
      vendorNameRaw: purchases.vendorNameRaw,
      payeeName: advancePayees.name,
    })
    .from(purchaseItems)
    .innerJoin(purchases, eq(purchases.id, purchaseItems.purchaseId))
    .leftJoin(advancePayees, eq(advancePayees.id, purchaseItems.advancePayee))
    .where(eq(purchaseItems.isAdvance, true))
    .orderBy(purchases.purchaseDate);
  const list = rows
    .filter((r) =>
      settled === "all"
        ? true
        : settled === "1"
          ? !!r.item.advanceSettledAt
          : !r.item.advanceSettledAt,
    )
    .map((r) => ({
      ...r.item,
      purchaseDate: r.purchaseDate,
      vendorName: r.vendorNameRaw,
      payeeName: r.payeeName,
    }));
  return c.json({
    items: list,
    totalCents: list.reduce((s, i) => s + i.amountCents, 0),
  });
});

purchaseItemsRoute.post("/:id/reset-rule", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const db = createDb(c.env.DB);
  const [item] = await db
    .select()
    .from(purchaseItems)
    .where(eq(purchaseItems.id, id))
    .limit(1);
  if (!item) return c.json({ error: "not_found" }, 404);
  if (item.categorySource !== "rule")
    return c.json({ error: "not_rule_applied" }, 409);
  const now = new Date().toISOString();
  const [batch] = await db
    .insert(itemChangeBatches)
    .values({
      itemIds: JSON.stringify([id]),
      changes: JSON.stringify({ categoryId: null }),
      before: JSON.stringify({
        [id]: {
          categoryId: item.categoryId,
          categorySource: item.categorySource,
        },
      }),
      actorMemberId: auth.memberId,
    })
    .returning({ id: itemChangeBatches.id });
  await db.batch([
    db
      .update(purchaseItems)
      .set({ categoryId: null, categorySource: null, updatedAt: now })
      .where(eq(purchaseItems.id, id)),
    db.insert(activityLog).values({
      entityType: "purchase",
      entityId: item.purchaseId,
      kind: "review",
      text: `${auth.name ?? auth.email ?? "系統"} 品項 ${id}「${item.name}」自動規則帶入的類別改回未分類(批次 #${batch.id})`,
      actorMemberId: auth.memberId,
    }),
  ]);
  return c.json({ ok: true, batchId: batch.id });
});

purchaseItemsRoute.post("/:id/asset", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const db = createDb(c.env.DB);
  const [row] = await db
    .select({ item: purchaseItems, purchase: purchases })
    .from(purchaseItems)
    .innerJoin(purchases, eq(purchases.id, purchaseItems.purchaseId))
    .where(eq(purchaseItems.id, id))
    .limit(1);
  if (!row) return c.json({ error: "not_found" }, 404);
  const { item, purchase } = row;
  const [existing] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(
      and(
        eq(assets.purchaseId, purchase.id),
        eq(assets.name, item.name),
        item.serialNo
          ? eq(assets.serialNo, item.serialNo)
          : isNull(assets.serialNo),
      ),
    )
    .limit(1);
  if (existing)
    return c.json({ error: "asset_exists", assetId: existing.id }, 409);
  const year =
    Number(purchase.purchaseDate.slice(0, 4)) || new Date().getFullYear();
  const assetId = await nextId(db, "AST", year);
  await db.batch([
    db.insert(assets).values({
      id: assetId,
      ownership: item.ownership ?? purchase.ownership,
      name: item.name,
      brand: item.brand,
      model: item.model,
      serialNo: item.serialNo,
      acquiredDate: purchase.purchaseDate,
      warrantyEndDate: item.warrantyEndDate,
      purchaseId: purchase.id,
      vendorName: purchase.vendorNameRaw,
      amountCents: item.amountCents >= 0 ? item.amountCents : null,
      currency: purchase.currency ?? "TWD",
      note: `由品項 ${item.id} 建立`,
      createdByMemberId: auth.memberId,
    }),
    db.insert(activityLog).values({
      entityType: "purchase",
      entityId: purchase.id,
      kind: "review",
      text: `${auth.name ?? auth.email ?? "系統"} 由品項 ${item.id}「${item.name}」建立資產 ${assetId}`,
      actorMemberId: auth.memberId,
    }),
  ]);
  return c.json({ ok: true, assetId }, 201);
});

purchaseItemsRoute.post("/:id", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const body = await c.req.json<ItemBody>().catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);
  const parsed = parseItemBody(body, true);
  if ("field" in parsed)
    return c.json({ error: "invalid_field", field: parsed.field }, 400);
  const db = createDb(c.env.DB);
  const [item] = await db
    .select()
    .from(purchaseItems)
    .where(eq(purchaseItems.id, id))
    .limit(1);
  if (!item) return c.json({ error: "not_found" }, 404);
  if (!Object.keys(parsed.patch).length)
    return c.json({ ok: true, unchanged: true });
  const changes = Object.keys(parsed.patch).join("、");
  await db.batch([
    db
      .update(purchaseItems)
      .set({ ...parsed.patch, updatedAt: new Date().toISOString() })
      .where(eq(purchaseItems.id, id)),
    db.insert(activityLog).values({
      entityType: "purchase",
      entityId: item.purchaseId,
      kind: "review",
      text: `${auth.name ?? auth.email ?? "系統"} 修改品項 ${id}「${item.name}」:${changes}${parsed.patch.ownership !== undefined ? `(歸屬 ${item.ownership ?? "跟發票"} → ${parsed.patch.ownership ?? "跟發票"})` : ""}`,
      actorMemberId: auth.memberId,
    }),
  ]);
  return c.json({ ok: true });
});

purchaseItemsRoute.post("/:id/delete", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const db = createDb(c.env.DB);
  const [item] = await db
    .select()
    .from(purchaseItems)
    .where(eq(purchaseItems.id, id))
    .limit(1);
  if (!item) return c.json({ error: "not_found" }, 404);
  await db.batch([
    db
      .update(documentPurchaseLinks)
      .set({ purchaseItemId: null })
      .where(eq(documentPurchaseLinks.purchaseItemId, id)),
    db
      .update(purchaseAttachments)
      .set({ purchaseItemId: null })
      .where(eq(purchaseAttachments.purchaseItemId, id)),
    db.delete(purchaseItems).where(eq(purchaseItems.id, id)),
    db.insert(activityLog).values({
      entityType: "purchase",
      entityId: item.purchaseId,
      kind: "review",
      text: `${auth.name ?? auth.email ?? "系統"} 刪除品項 ${id}「${item.name}」(掛在上面的文件/附件改回物件層)`,
      actorMemberId: auth.memberId,
    }),
  ]);
  return c.json({ ok: true });
});

purchaseItemsRoute.post("/:id/split", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const body = await c.req.json<{ quantities?: unknown }>().catch(() => null);
  const quantities = Array.isArray(body?.quantities)
    ? (body!.quantities as unknown[]).map(Number)
    : [];
  const db = createDb(c.env.DB);
  const [item] = await db
    .select()
    .from(purchaseItems)
    .where(eq(purchaseItems.id, id))
    .limit(1);
  if (!item) return c.json({ error: "not_found" }, 404);
  let parts: Array<{ quantity: number; amountCents: number }>;
  try {
    if (quantities.length < 2) throw new Error("至少要拆成兩個");
    parts = splitItem(item, quantities);
  } catch (err) {
    return c.json(
      {
        error: "invalid_split",
        message: err instanceof Error ? err.message : String(err),
      },
      400,
    );
  }
  const [purchase] = await db
    .select({ purchaseDate: purchases.purchaseDate })
    .from(purchases)
    .where(eq(purchases.id, item.purchaseId))
    .limit(1);
  const year =
    Number(purchase?.purchaseDate.slice(0, 4)) || new Date().getFullYear();
  const siblings = await db
    .select({ id: purchaseItems.id })
    .from(purchaseItems)
    .where(and(eq(purchaseItems.purchaseId, item.purchaseId)));
  const newIds: string[] = [];
  for (let i = 1; i < parts.length; i++)
    newIds.push(await nextId(db, "PIT", year));
  const now = new Date().toISOString();
  await db.batch([
    db
      .update(purchaseItems)
      .set({
        quantity: parts[0].quantity,
        amountCents: parts[0].amountCents,
        updatedAt: now,
      })
      .where(eq(purchaseItems.id, id)),
    ...itemInsertStatements(
      db,
      parts.slice(1).map((p, i) => ({
        id: newIds[i],
        purchaseId: item.purchaseId,
        lineNo: item.lineNo,
        name: item.name,
        quantity: p.quantity,
        unitPriceCents: item.unitPriceCents,
        amountCents: p.amountCents,
        brand: item.brand,
        model: item.model,
        serialNo: null,
        ownership: item.ownership,
        source: "split" as const,
        note: `由 ${id} 拆出`,
      })),
    ),
    db.insert(activityLog).values({
      entityType: "purchase",
      entityId: item.purchaseId,
      kind: "review",
      text: `${auth.name ?? auth.email ?? "系統"} 拆分品項 ${id}「${item.name}」數量 ${item.quantity} → ${quantities.join(" + ")}(新品項 ${newIds.join("、")})`,
      actorMemberId: auth.memberId,
    }),
  ]);
  return c.json({
    ok: true,
    itemIds: [id, ...newIds],
    siblings: siblings.length + newIds.length,
  });
});
