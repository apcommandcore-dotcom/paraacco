// 2026-09-29 CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md 第六節測試(API 層):
//   物件金額只取主文件、附件不影響月報表;先收據後發票 → 發票接手主文件;同發票號不同寫法 → 重複檔;
//   歸屬衝突警告;影片只存 NAS 路徑;移出附件恢復獨立物件;5 行明細 → 5 品項 + 金額不符;品項改歸屬 → 月報表拆分;
//   截止日後混合歸屬 → 警告 + 待確認;保固掛品項 → 出現在「保固與訂閱」。

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createDb, documentExtractedFields, documentFiles, documentPurchaseLinks, documents, members, purchaseAttachments, purchaseItems, purchases } from "@paraacco/db";
import { purchasesRoute } from "../src/routes/purchases";
import { purchaseItemsRoute } from "../src/routes/purchase-items";
import { reportsRoute } from "../src/routes/reports";
import { settingsRoute } from "../src/routes/settings";
import { warrantyRoute } from "../src/routes/warranty";
import { archiveRoute } from "../src/routes/archive";
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
app.route("/settings", settingsRoute);
app.route("/warranty", warrantyRoute);
app.route("/archive", archiveRoute);
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
const get = async <T>(path: string) => (await (await app.request(path, {}, env)).json()) as T;

const ROOT = "Paraacco_公司財務系統/10_平行空間有限公司/2026/01_發票收據/";
async function seed(id: string, type: string, o: Partial<typeof documents.$inferInsert>, lineItems?: unknown[]) {
  const db = createDb(env.DB);
  await db.insert(documents).values({ id, ownership: "corp", source: "api_import", status: "review", invoiceDate: "2026-09-10", ...o });
  await db.insert(documentFiles).values({
    documentId: id,
    kind: "original",
    r2Key: `local:${id}`,
    originalFileName: `${id}.pdf`,
    mimeType: "application/pdf",
    byteSize: 1,
    sha256: "b".repeat(64),
    storage: "local",
    localPath: `${ROOT}20260910_${type}_店_${(o.amountCents ?? 0) / 100}_${id}.pdf`,
  });
  if (lineItems) {
    await db.insert(documentExtractedFields).values({ documentId: id, fieldKey: "line_items", label: "品項明細", value: JSON.stringify(lineItems), extractionSource: "ai_inference" });
  }
}

type Report = {
  general: { rows: Array<{ key: string; amountCents: number; attachmentSummary: string; items: unknown[]; mixedOwnership: boolean; itemAmountMismatch: boolean; needsConfirm: boolean }>; subtotals: { cents: number; byOwnership: Record<string, { cents: number }> } };
  recurring: { rows: unknown[]; subtotals: { cents: number } };
  total: { cents: number; count: number };
  pendingConfirm: string[];
};

describe("物件(採購案)", () => {
  beforeAll(async () => {
    await createDb(env.DB).insert(members).values({ id: AUTH.memberId!, email: AUTH.email!, name: AUTH.name!, role: AUTH.role!, scope: AUTH.scope! });
  });

  it("士東企業:發票 + 收據合併 → 發票主文件、收據附件、歸屬衝突;發票 2 行明細 → 2 品項、金額不符", async () => {
    await seed("DOC-2026-200111", "發票", { amountCents: 77000, invoiceNo: "FD-52990572", invoiceDate: "2026-09-08" }, [
      { name: "3M 紙膠帶(藍色)", qty: 7, unitPrice: 19, amount: 133 },
      { name: "工程帽(白色)", qty: 5, unitPrice: 120, amount: 600 },
    ]);
    await seed("DOC-2026-200116", "收據", { amountCents: 77000, ownership: "per", invoiceDate: "2026-09-08" });
    const cands = await get<{ candidates: Array<{ documentId: string; rule: number; ownershipConflict: boolean }> }>("/purchases/merge-candidates?documentId=DOC-2026-200116");
    expect(cands.candidates[0]).toMatchObject({ documentId: "DOC-2026-200111", rule: 4, ownershipConflict: true });

    const res = await post("/purchases/merge", { documentIds: ["DOC-2026-200116", "DOC-2026-200111"] });
    expect(res.status).toBe(201);
    const { purchaseId, ownershipConflicts, itemIds } = (await res.json()) as { purchaseId: string; ownershipConflicts: string[]; itemIds: string[] };
    expect(ownershipConflicts).toEqual(["DOC-2026-200116"]);
    expect(itemIds).toHaveLength(2);
    const detail = await get<{ object: { primary: { documentId: string }; documents: Array<{ documentId: string; attachmentRole: string | null }>; flags: Record<string, unknown>; purchase: { amountCents: number; ownership: string } } }>(`/purchases/${purchaseId}`);
    expect(detail.object.primary.documentId).toBe("DOC-2026-200111");
    expect(detail.object.documents.find((d) => d.documentId === "DOC-2026-200116")?.attachmentRole).toBe("RET");
    expect(detail.object.flags).toMatchObject({ itemAmountMismatch: true, mixedOwnership: false, ownershipConflicts: ["DOC-2026-200116"] });
    expect(detail.object.purchase).toMatchObject({ amountCents: 77000, ownership: "corp" });
  });

  it("月報表:物件金額只取主文件,附件不計;兩段小計加總 = 總計", async () => {
    const r = await get<Report>("/reports/monthly?month=2026-09");
    const row = r.general.rows.find((x) => x.key.startsWith("PUR-"))!;
    expect(row.amountCents).toBe(77000);
    expect(r.general.rows.some((x) => x.key === "DOC-2026-200116")).toBe(false);
    expect(row.attachmentSummary).toBe("收據 1");
    expect(r.total.cents).toBe(r.general.subtotals.cents + r.recurring.subtotals.cents);
  });

  it("品項改歸屬 → 月報表公司/個人小計依品項拆分,總計不變;截止日前不警告", async () => {
    const before = await get<Report>("/reports/monthly?month=2026-09");
    const [tape] = await createDb(env.DB).select().from(purchaseItems).where(eq(purchaseItems.name, "3M 紙膠帶(藍色)"));
    expect((await post(`/purchase-items/${tape.id}`, { ownership: "per" })).status).toBe(200);
    const after = await get<Report>("/reports/monthly?month=2026-09");
    expect(after.total.cents).toBe(before.total.cents);
    expect(after.general.subtotals.byOwnership.per.cents - (before.general.subtotals.byOwnership.per?.cents ?? 0)).toBe(13300);
    const row = after.general.rows.find((x) => x.key.startsWith("PUR-"))!;
    expect(row).toMatchObject({ mixedOwnership: true, needsConfirm: false });
    expect(after.pendingConfirm).toEqual([]);
  });

  it("截止日(系統設定可改)後的發票設成混合歸屬 → 警告並列入待確認", async () => {
    expect((await post("/settings/mixed_ownership_cutoff", { value: "2026-09-01" })).status).toBe(200);
    expect((await get<{ settings: Record<string, string> }>("/settings")).settings.mixed_ownership_cutoff).toBe("2026-09-01");
    const r = await get<Report>("/reports/monthly?month=2026-09");
    expect(r.pendingConfirm).toHaveLength(1);
    const pid = r.pendingConfirm[0];
    expect((await get<{ object: { flags: { mixedOwnershipWarning: boolean } } }>(`/purchases/${pid}`)).object.flags.mixedOwnershipWarning).toBe(true);
    expect((await post("/settings/mixed_ownership_cutoff", { value: "2026/10/01" })).status).toBe(400);
    await post("/settings/mixed_ownership_cutoff", { value: "2026-10-01" });
  });

  it("先有收據、後有發票:發票進來後自動接手主文件,收據轉附件,品項換成發票明細", async () => {
    await seed("DOC-2026-200201", "收據", { amountCents: 32000, invoiceDate: "2026-09-08" });
    const created = (await (await post("/purchases/merge", { documentIds: ["DOC-2026-200201"] })).json()) as { purchaseId: string; itemIds: string[] };
    expect(created.itemIds).toEqual([]);
    await seed("DOC-2026-200202", "發票", { amountCents: 32000, invoiceNo: "FG-35842095", invoiceDate: "2026-09-08" }, [{ name: "觀音韻", qty: 8, amount: 320 }]);
    const res = await post(`/purchases/${created.purchaseId}/documents`, { documentId: "DOC-2026-200202" });
    expect(await res.json()).toMatchObject({ relationKind: "primary", tookOverPrimary: true });
    const detail = await get<{ object: { primary: { documentId: string }; documents: Array<{ documentId: string; relationKind: string; attachmentRole: string }>; items: Array<{ name: string }> } }>(`/purchases/${created.purchaseId}`);
    expect(detail.object.primary.documentId).toBe("DOC-2026-200202");
    expect(detail.object.documents.find((d) => d.documentId === "DOC-2026-200201")).toMatchObject({ relationKind: "supporting", attachmentRole: "RET" });
    expect(detail.object.items.map((i) => i.name)).toEqual(["觀音韻"]);
    // 已有發票時,再來一張發票不會接手
    await seed("DOC-2026-200203", "發票", { amountCents: 32000, invoiceNo: "FG-00000001" });
    expect(await (await post(`/purchases/${created.purchaseId}/documents`, { documentId: "DOC-2026-200203", role: "OTHER" })).json()).toMatchObject({ relationKind: "supporting" });
  });

  it("從物件移出附件後,該文件恢復成獨立物件,統計正確;移出最後一份 → 物件解散", async () => {
    const [link] = await createDb(env.DB).select().from(documentPurchaseLinks).where(eq(documentPurchaseLinks.documentId, "DOC-2026-200203"));
    expect((await post(`/purchases/${link.purchaseId}/documents/DOC-2026-200203/remove`, {})).status).toBe(200);
    const r = await get<Report>("/reports/monthly?month=2026-09");
    expect(r.general.rows.some((x) => x.key === "DOC-2026-200203")).toBe(true);

    await seed("DOC-2026-200301", "收據", { amountCents: 100 });
    const { purchaseId } = (await (await post("/purchases/merge", { documentIds: ["DOC-2026-200301"] })).json()) as { purchaseId: string };
    expect(await (await post(`/purchases/${purchaseId}/documents/DOC-2026-200301/remove`, {})).json()).toMatchObject({ objectDeleted: true });
    expect(await createDb(env.DB).select().from(purchases).where(eq(purchases.id, purchaseId))).toEqual([]);
  });

  it("同發票號不同寫法 → 標成重複檔候選,不是附件;一份文件不能同時屬於兩個物件", async () => {
    await seed("DOC-2026-200401", "發票", { amountCents: 6900, invoiceNo: "FK60843564" });
    await seed("DOC-2026-200402", "發票", { amountCents: 6900, invoiceNo: "FK-60843564" });
    const cands = await get<{ candidates: Array<{ documentId: string; rule: number; duplicate: boolean }> }>("/purchases/merge-candidates?documentId=DOC-2026-200402");
    expect(cands.candidates.find((c) => c.documentId === "DOC-2026-200401")).toMatchObject({ rule: 1, duplicate: true });
    const { purchaseId } = (await (await post("/purchases/merge", { documentIds: ["DOC-2026-200401"] })).json()) as { purchaseId: string };
    await seed("DOC-2026-200403", "收據", { amountCents: 6900 });
    const other = (await (await post("/purchases/merge", { documentIds: ["DOC-2026-200403"] })).json()) as { purchaseId: string };
    const res = await post(`/purchases/${other.purchaseId}/documents`, { documentId: "DOC-2026-200401" });
    expect(res.status).toBe(409);
    expect((await post("/purchases/merge", { documentIds: ["DOC-2026-200401", "DOC-2026-200403"] })).status).toBe(409);
    expect(purchaseId).not.toBe(other.purchaseId);
  });

  it("5 行明細 → 5 品項;加總相符不標不符;品項拆分", async () => {
    await seed("DOC-2026-200501", "發票", { amountCents: 50000, invoiceNo: "AB12345678" }, [
      { name: "A", amount: 100 },
      { name: "B", qty: 2, unitPrice: 50, amount: 100 },
      { name: "C", amount: 300 },
      { name: "D", qty: 3, unitPrice: 10 },
      { name: "折價", amount: -30 },
    ]);
    const { purchaseId, itemIds } = (await (await post("/purchases/merge", { documentIds: ["DOC-2026-200501"] })).json()) as { purchaseId: string; itemIds: string[] };
    expect(itemIds).toHaveLength(5);
    expect((await get<{ object: { flags: { itemAmountMismatch: boolean } } }>(`/purchases/${purchaseId}`)).object.flags.itemAmountMismatch).toBe(false);
    const res = await post(`/purchase-items/${itemIds[1]}/split`, { quantities: [1, 1] });
    expect(res.status).toBe(200);
    const items = await createDb(env.DB).select().from(purchaseItems).where(eq(purchaseItems.purchaseId, purchaseId));
    expect(items).toHaveLength(6);
    expect(items.filter((i) => i.name === "B").map((i) => i.amountCents).sort()).toEqual([5000, 5000]);
  });

  it("影片加入物件:只存 NAS 路徑;保固掛品項 → 出現在「保固與訂閱」", async () => {
    const [item] = await createDb(env.DB).select().from(purchaseItems).where(eq(purchaseItems.name, "C"));
    const bad = await post(`/purchases/${item.purchaseId}/attachments`, { kind: "video", localPath: "/etc/passwd" });
    expect(bad.status).toBe(400);
    const res = await post(`/purchases/${item.purchaseId}/attachments`, { kind: "video", localPath: "_系統外資料/影片/IMG_0001.MOV", itemId: item.id });
    expect(res.status).toBe(201);
    const [att] = await createDb(env.DB).select().from(purchaseAttachments).where(eq(purchaseAttachments.purchaseId, item.purchaseId));
    expect(att).toMatchObject({ kind: "video", localPath: "_系統外資料/影片/IMG_0001.MOV", purchaseItemId: item.id });

    await post(`/purchase-items/${item.id}`, { warrantyStartDate: "2026-09-10", warrantyEndDate: "2027-09-09", serialNo: "SN-1" });
    const w = await get<{ itemWarranties: Array<{ itemId: string; endDate: string; purchaseId: string }> }>("/warranty");
    expect(w.itemWarranties).toEqual([expect.objectContaining({ itemId: item.id, endDate: "2027-09-09", purchaseId: item.purchaseId })]);

    const objs = await get<{ links: unknown[]; attachments: Array<{ localPath: string }> }>("/archive/objects");
    expect(objs.attachments.map((a) => a.localPath)).toContain("_系統外資料/影片/IMG_0001.MOV");
    const mv = await post("/archive/attachment-moves", {
      moves: [{ attachmentId: att.id, fromPath: att.localPath, toPath: `${ROOT}20260910_發票_店_500_DOC-2026-200501_附件_影片_01.MOV` }],
    });
    expect(await mv.json()).toMatchObject({ ok: true, written: 1 });
  });

  it("回溯合併端點:逐筆建物件,已屬物件的回錯誤不中斷", async () => {
    await seed("DOC-2026-200601", "發票", { amountCents: 64800, invoiceNo: "FK-02825074" });
    await seed("DOC-2026-200602", "收據", { amountCents: 64800, ownership: "per" });
    const res = await post("/archive/purchase-objects", {
      objects: [
        { primaryDocumentId: "DOC-2026-200601", attachments: [{ documentId: "DOC-2026-200602", role: "RET" }], note: "規則 4" },
        { primaryDocumentId: "DOC-2026-200401", attachments: [] },
      ],
    });
    const body = (await res.json()) as { results: Array<{ ok: boolean; error?: string }> };
    expect(body.results.map((r) => r.ok)).toEqual([true, false]);
    expect(body.results[1].error).toBe("already_in_object");
  });

  it("30 行明細的發票(好市多)一次建立 30 個品項,不超過 D1 的 100 個綁定參數", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({ name: `商品 ${i + 1}`, code: String(100000 + i), qty: 1, unitPrice: 10, amount: 10 }));
    await seed("DOC-2026-200701", "發票", { amountCents: 30000, invoiceNo: "FK60843488" }, lines);
    const res = await post("/purchases/merge", { documentIds: ["DOC-2026-200701"] });
    expect(res.status).toBe(201);
    const { itemIds, purchaseId } = (await res.json()) as { itemIds: string[]; purchaseId: string };
    expect(itemIds).toHaveLength(30);
    expect((await get<{ object: { flags: { itemAmountMismatch: boolean } } }>(`/purchases/${purchaseId}`)).object.flags.itemAmountMismatch).toBe(false);
  });
});
