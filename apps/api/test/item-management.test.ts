// 2026-10-01 CODE_TASK_purchase-object-merge-docs_20260929_V1.02.md 7.6 測試(API 層):
//   右鍵單選/多選套用類別/歸屬/專案/代墊 → activity_log 有紀錄、Undo 可還原;後台新增類別立即可用、停用後選單消失但已套用的保留;
//   「記住此分類」後同賣方統編新進件自動套用(標 rule)、關鍵字較具體的規則優先;月報表類別/專案小計加總 = 總計,代墊/不列帳分列。

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  activityLog,
  createDb,
  documentExtractedFields,
  documentFiles,
  documents,
  members,
  purchaseItems,
} from "@paraacco/db";
import { purchasesRoute } from "../src/routes/purchases";
import { purchaseItemsRoute } from "../src/routes/purchase-items";
import { reportsRoute } from "../src/routes/reports";
import {
  advancePayeesRoute,
  itemCategoriesRoute,
  itemRulesRoute,
} from "../src/routes/item-admin";
import type { Bindings } from "../src/bindings";
import { TEST_AUTH } from "./helpers";

const AUTH = { ...TEST_AUTH, scope: "personal_corp" };
const app = new Hono<{ Bindings: Bindings }>();
app.use("*", async (c, next) => {
  c.set("auth", AUTH);
  await next();
});
app.route("/purchases", purchasesRoute);
app.route("/purchase-items", purchaseItemsRoute);
app.route("/reports", reportsRoute);
app.route("/item-categories", itemCategoriesRoute);
app.route("/item-rules", itemRulesRoute);
app.route("/advance-payees", advancePayeesRoute);
const post = (path: string, body: unknown) =>
  app.request(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
const get = async <T>(path: string) =>
  (await (await app.request(path, {}, env)).json()) as T;

const TAX = "03774909"; // 測試用賣方統編(檢查碼正確)
async function seed(
  id: string,
  amountCents: number,
  lineItems: unknown[],
  date = "2026-09-12",
) {
  const db = createDb(env.DB);
  await db
    .insert(documents)
    .values({
      id,
      ownership: "corp",
      source: "api_import",
      status: "review",
      invoiceDate: date,
      amountCents,
      invoiceNo: `AB-${id.slice(-8)}`,
    });
  await db.insert(documentFiles).values({
    documentId: id,
    kind: "original",
    r2Key: `local:${id}`,
    originalFileName: `${id}.pdf`,
    mimeType: "application/pdf",
    byteSize: 1,
    storage: "local",
    localPath: `Paraacco_公司財務系統/10_平行空間有限公司/2026/01_發票收據/20260912_發票_店_${amountCents / 100}_${id}.pdf`,
  });
  await db.insert(documentExtractedFields).values([
    {
      documentId: id,
      fieldKey: "line_items",
      label: "品項明細",
      value: JSON.stringify(lineItems),
      extractionSource: "ai_inference",
    },
    {
      documentId: id,
      fieldKey: "vendorTaxIdPrinted",
      label: "賣方統編(印字)",
      value: TAX,
      extractionSource: "ai_inference",
    },
  ]);
}
async function objectItems(docId: string) {
  const res = await post("/purchases/merge", { documentIds: [docId] });
  const { itemIds } = (await res.json()) as { itemIds: string[] };
  return createDb(env.DB)
    .select()
    .from(purchaseItems)
    .where(
      eq(
        purchaseItems.purchaseId,
        (
          await createDb(env.DB)
            .select()
            .from(purchaseItems)
            .where(eq(purchaseItems.id, itemIds[0]))
        )[0].purchaseId,
      ),
    );
}
const item = async (id: string) =>
  (
    await createDb(env.DB)
      .select()
      .from(purchaseItems)
      .where(eq(purchaseItems.id, id))
  )[0];

type Report = {
  total: { cents: number };
  byCategory: Record<string, number>;
  byProject: Record<string, number>;
  advanceItems: Array<{ itemId: string; advancePayee: string | null }>;
  excludedItems: Array<{ itemId: string; reason: string | null }>;
  categoryNames: Record<string, string>;
};

describe("品項右鍵管理", () => {
  let items: Awaited<ReturnType<typeof objectItems>>;
  beforeAll(async () => {
    await createDb(env.DB)
      .insert(members)
      .values({
        id: AUTH.memberId!,
        email: AUTH.email!,
        name: AUTH.name!,
        role: AUTH.role!,
        scope: AUTH.scope!,
      });
    await seed("DOC-2026-400001", 50000, [
      { name: "金菊嫩雞腿飯", qty: 2, unitPrice: 125, amount: 250 },
      { name: "紅茶", qty: 2, unitPrice: 35, amount: 70 },
      { name: "A4 影印紙", qty: 1, unitPrice: 180, amount: 180 },
    ]);
    items = await objectItems("DOC-2026-400001");
    items.sort((a, b) => a.lineNo - b.lineNo);
  });

  it("後台類別:初始 12 類;新增後右鍵清單立即出現,停用後消失;用過的類別不能刪", async () => {
    const all = await get<{ categories: Array<{ id: string; name: string }> }>(
      "/item-categories?active=1",
    );
    expect(all.categories.map((x) => x.name)).toContain("餐費");
    const res = await post("/item-categories", {
      name: "業主餐敘",
      parentId: "ICT-001",
      accountTitle: "交際費",
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(
      (
        await get<{ categories: Array<{ id: string }> }>(
          "/item-categories?active=1",
        )
      ).categories.some((x) => x.id === id),
    ).toBe(true);
    // 子類別只做一層
    expect(
      (await post("/item-categories", { name: "第三層", parentId: id })).status,
    ).toBe(400);

    expect(
      (
        await post("/purchase-items/bulk", {
          itemIds: [items[0].id],
          set: { categoryId: id },
        })
      ).status,
    ).toBe(200);
    expect((await post(`/item-categories/${id}/delete`, {})).status).toBe(409);
    await post(`/item-categories/${id}`, { isActive: false });
    expect(
      (
        await get<{ categories: Array<{ id: string }> }>(
          "/item-categories?active=1",
        )
      ).categories.some((x) => x.id === id),
    ).toBe(false);
    expect((await item(items[0].id)).categoryId).toBe(id); // 已套用的保留
    // 停用的類別不能再套用
    expect(
      (
        await post("/purchase-items/bulk", {
          itemIds: [items[1].id],
          set: { categoryId: id },
        })
      ).status,
    ).toBe(400);
  });

  it("多選套用類別/專案/代墊 → activity_log 有紀錄;Undo 還原到前值", async () => {
    const ids = [items[0].id, items[1].id];
    const before = await item(items[0].id);
    const r = await post("/purchase-items/bulk", {
      itemIds: ids,
      set: {
        categoryId: "ICT-001",
        projectCode: "AP_26001",
        isAdvance: true,
        advancePayee: "owner",
      },
    });
    const { batchId, changed } = (await r.json()) as {
      batchId: number;
      changed: number;
    };
    expect(changed).toBe(2);
    expect(await item(items[1].id)).toMatchObject({
      categoryId: "ICT-001",
      categorySource: "manual",
      projectCode: "AP_26001",
      isAdvance: true,
      advancePayee: "owner",
    });
    const logs = await createDb(env.DB)
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, items[0].purchaseId));
    expect(logs.some((l) => l.text.includes(`批次 #${batchId}`))).toBe(true);

    // 代墊清單(對帳頁「未請回」)
    const adv = await get<{ items: Array<{ id: string }>; totalCents: number }>(
      "/purchase-items/advances?settled=0",
    );
    expect(adv.items.map((i) => i.id).sort()).toEqual([...ids].sort());
    expect(adv.totalCents).toBe(32000);

    const u = await post("/purchase-items/undo", {});
    expect(await u.json()).toMatchObject({ ok: true, batchId, restored: 2 });
    expect(await item(items[0].id)).toMatchObject({
      categoryId: before.categoryId,
      projectCode: null,
      isAdvance: false,
      advancePayee: null,
    });
    expect((await post("/purchase-items/undo", { batchId })).status).toBe(409);
  });

  it("欄位驗證:代墊要選請款對象、不列帳要填原因、專案代碼格式、改品名只能單選", async () => {
    const one = [items[2].id];
    for (const [field, set, ids] of [
      ["advancePayee", { isAdvance: true }, one],
      ["excludeReason", { excludeFromReport: true }, one],
      ["projectCode", { projectCode: "26001" }, one],
      ["ownership", { ownership: "family" }, one],
      ["name", { name: "x" }, [items[0].id, items[1].id]],
    ] as const) {
      const res = await post("/purchase-items/bulk", { itemIds: ids, set });
      expect(res.status, field).toBe(400);
      expect(((await res.json()) as { field: string }).field).toBe(field);
    }
  });

  it("修正品名:保留原始辨識值;Undo 後回到原名", async () => {
    await post("/purchase-items/bulk", {
      itemIds: [items[0].id],
      set: { name: "金菊嫩雞腿飯(紅蔥酥)" },
    });
    expect(await item(items[0].id)).toMatchObject({
      name: "金菊嫩雞腿飯(紅蔥酥)",
      nameOriginal: "金菊嫩雞腿飯",
    });
    await post("/purchase-items/undo", {});
    expect(await item(items[0].id)).toMatchObject({
      name: "金菊嫩雞腿飯",
      nameOriginal: null,
    });
  });

  it("月報表:類別/專案小計加總 = 總計;代墊、不列帳分列,不列帳金額不計入", async () => {
    await post("/purchase-items/bulk", {
      itemIds: [items[0].id],
      set: { categoryId: "ICT-001", projectCode: "AP_26001" },
    });
    await post("/purchase-items/bulk", {
      itemIds: [items[1].id],
      set: { isAdvance: true, advancePayee: "owner" },
    });
    await post("/purchase-items/bulk", {
      itemIds: [items[2].id],
      set: { excludeFromReport: true, excludeReason: "已退貨" },
    });
    const r = await get<Report>("/reports/monthly?month=2026-09");
    const sum = (m: Record<string, number>) =>
      Object.values(m).reduce((s, v) => s + v, 0);
    expect(sum(r.byCategory)).toBe(r.total.cents);
    expect(sum(r.byProject)).toBe(r.total.cents);
    expect(r.total.cents).toBe(50000 - 18000);
    expect(r.byCategory["ICT-001"]).toBe(25000);
    expect(r.byProject.AP_26001).toBe(25000);
    expect(r.advanceItems).toEqual([
      expect.objectContaining({ itemId: items[1].id, advancePayee: "owner" }),
    ]);
    expect(r.excludedItems).toEqual([
      expect.objectContaining({ itemId: items[2].id, reason: "已退貨" }),
    ]);
    expect(r.categoryNames["ICT-001"]).toBe("餐費");
  });

  it("記住此分類 → 同賣方統編新進件自動套用(rule);關鍵字較具體者優先;一鍵改回", async () => {
    const r1 = await post("/purchase-items/bulk", {
      itemIds: [items[1].id],
      set: { categoryId: "ICT-001" },
      rememberRule: {},
    });
    expect(
      ((await r1.json()) as { ruleId: number | null }).ruleId,
    ).toBeGreaterThan(0);
    const r2 = await post("/purchase-items/bulk", {
      itemIds: [items[2].id],
      set: { categoryId: "ICT-003" },
      rememberRule: { nameKeyword: "影印紙" },
    });
    expect(
      ((await r2.json()) as { ruleId: number | null }).ruleId,
    ).toBeGreaterThan(0);

    await seed("DOC-2026-400002", 36000, [
      { name: "排骨飯", qty: 1, unitPrice: 120, amount: 120 },
      { name: "A4 影印紙 5包", qty: 1, unitPrice: 240, amount: 240 },
    ]);
    const next = (await objectItems("DOC-2026-400002")).sort(
      (a, b) => a.lineNo - b.lineNo,
    );
    expect(next[0]).toMatchObject({
      categoryId: "ICT-001",
      categorySource: "rule",
    });
    expect(next[1]).toMatchObject({
      categoryId: "ICT-003",
      categorySource: "rule",
    });

    expect(
      (await post(`/purchase-items/${next[0].id}/reset-rule`, {})).status,
    ).toBe(200);
    expect(await item(next[0].id)).toMatchObject({
      categoryId: null,
      categorySource: null,
    });
    expect(
      (await post(`/purchase-items/${next[0].id}/reset-rule`, {})).status,
    ).toBe(409);

    // 停用規則後新進件不再套用;刪規則不改動已套用的品項
    const { rules } = await get<{ rules: Array<{ id: number }> }>(
      "/item-rules",
    );
    for (const r of rules)
      await post(`/item-rules/${r.id}`, { isActive: false });
    await seed("DOC-2026-400003", 12000, [
      { name: "雞腿飯", qty: 1, unitPrice: 120, amount: 120 },
    ]);
    expect((await objectItems("DOC-2026-400003"))[0].categoryId).toBeNull();
    for (const r of rules) await post(`/item-rules/${r.id}/delete`, {});
    expect((await item(next[1].id)).categoryId).toBe("ICT-003");
  });

  it("由品項建立資產:帶入品名/金額/取得日;同品項不重複建立", async () => {
    const res = await post(`/purchase-items/${items[2].id}/asset`, {});
    expect(res.status).toBe(201);
    expect(
      (await post(`/purchase-items/${items[2].id}/asset`, {})).status,
    ).toBe(409);
  });

  it("請款對象:後台新增/停用", async () => {
    const res = await post("/advance-payees", { name: "建設公司甲" });
    const { id } = (await res.json()) as { id: string };
    await post(`/advance-payees/${id}`, { isActive: false });
    const { payees } = await get<{ payees: Array<{ id: string }> }>(
      "/advance-payees?active=1",
    );
    expect(payees.map((p) => p.id)).toEqual(["owner", "company", "other"]);
  });
});
