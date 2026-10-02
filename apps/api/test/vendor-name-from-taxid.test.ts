// 2026-09-29 CODE_TASK_vendor-name-from-taxid_20260929.md 第四節:
//   - 82066492 → 展蝶企業社(已建檔),OCR 店名「展騰企業社」不參與;
//   - 未建檔統編 → 不對應、出現在待建檔清單;建檔後自動補對應;
//   - 檢查碼錯誤 → 列「統編無法辨識」、不比對;
//   - QR 與印字不一致 → 以 QR 為準、有註記。
// stage-7 直接呼叫 vendor-resolution.ts 的 checkDocumentVendor()(/internal 路由只是薄包裝,驗證走共用密鑰)。

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { createDb, documentExtractedFields, documentFiles, documents, members, vendors } from "@paraacco/db";
import { vendorsRoute } from "../src/routes/vendors";
import { archiveRoute } from "../src/routes/archive";
import { extractionWritebackRoute } from "../src/routes/extraction-writeback";
import { backfillVendorIds, checkDocumentVendor, listPendingVendors } from "../src/vendor-resolution";
import type { Bindings } from "../src/bindings";
import { TEST_AUTH } from "./helpers";

function buildApp() {
  const app = new Hono<{ Bindings: Bindings }>();
  app.use("*", async (c, next) => {
    c.set("auth", TEST_AUTH);
    await next();
  });
  app.route("/vendors", vendorsRoute);
  app.route("/archive", archiveRoute);
  app.route("/wb", extractionWritebackRoute);
  return app;
}
const post = (app: Hono<{ Bindings: Bindings }>, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);

async function seedDoc(id: string, fields: Record<string, string>, extra: Partial<typeof documents.$inferInsert> = {}) {
  const db = createDb(env.DB);
  await db.insert(documents).values({ id, ownership: "per", source: "api_import", status: "review", ...extra });
  await db.insert(documentFiles).values({
    documentId: id,
    kind: "original",
    r2Key: `local:${id}`,
    originalFileName: `${id}.pdf`,
    mimeType: "application/pdf",
    byteSize: 1,
    sha256: "a".repeat(64),
    storage: "local",
    localPath: `Paraacco_公司財務系統/00_收件/20260929/${id}.pdf`,
  });
  for (const [fieldKey, value] of Object.entries(fields)) {
    await db.insert(documentExtractedFields).values({
      documentId: id,
      fieldKey,
      label: fieldKey,
      value,
      extractionSource: "ai_inference",
      sourceNote: "外部擷取:test",
    });
  }
}

async function field(id: string, key: string) {
  const [row] = await createDb(env.DB)
    .select()
    .from(documentExtractedFields)
    .where(and(eq(documentExtractedFields.documentId, id), eq(documentExtractedFields.fieldKey, key)));
  return row?.value ?? null;
}

describe("供應商名稱一律由賣方統編對應主檔", () => {
  beforeAll(async () => {
    const db = createDb(env.DB);
    await db.insert(members).values({
      id: TEST_AUTH.memberId!,
      email: TEST_AUTH.email!,
      name: TEST_AUTH.name!,
      role: TEST_AUTH.role!,
      scope: TEST_AUTH.scope!,
    });
    await db.insert(vendors).values({ id: "vnd-展蝶企業社-56d0", name: "展蝶企業社", taxId: "82066492", defaultOwnership: "corp" });
    // 舊規則下會被名稱比對到的供應商:新規則不能再靠名稱對到。
    await db.insert(vendors).values({ id: "vnd-展騰", name: "展騰企業社", taxId: null, defaultOwnership: "corp" });
  });

  it("82066492 → 展蝶企業社;OCR 店名「展騰企業社」不參與", async () => {
    await seedDoc("DOC-2026-000061", { vendorTaxId: "82066492", vendorNameRaw: "展騰企業社" }, { vendorNameRaw: "展騰企業社" });
    const r = await checkDocumentVendor(createDb(env.DB), "DOC-2026-000061");
    expect(r).toMatchObject({ matchedVendorId: "vnd-展蝶企業社-56d0", matchedVendorName: "展蝶企業社", vendorStatus: "matched", forcedReview: false });
    expect(await field("DOC-2026-000061", "vendor_status")).toBe("matched");
    const [doc] = await createDb(env.DB).select().from(documents).where(eq(documents.id, "DOC-2026-000061"));
    expect(doc.vendorId).toBe("vnd-展蝶企業社-56d0");
    expect(doc.vendorNameRaw).toBe("展騰企業社"); // 原始店名照舊存,僅供參考

    const res = await buildApp().request("/archive/documents?ids=DOC-2026-000061", {}, env);
    const body = (await res.json()) as { documents: Array<{ vendorId: string; vendorName: string; vendorStatus: string }> };
    expect(body.documents[0]).toMatchObject({ vendorId: "vnd-展蝶企業社-56d0", vendorName: "展蝶企業社", vendorStatus: "matched" });
  });

  it("只有店名相同、沒有統編 → 不對應(名稱不再參與比對),列統編無法辨識", async () => {
    await seedDoc("DOC-2026-000901", { vendorNameRaw: "展騰企業社" }, { vendorNameRaw: "展騰企業社" });
    const r = await checkDocumentVendor(createDb(env.DB), "DOC-2026-000901");
    expect(r).toMatchObject({ matchedVendorId: null, vendorStatus: "taxid_unreadable", forcedReview: true });
  });

  it("檢查碼錯誤的統編 → 無法辨識、不比對", async () => {
    await seedDoc("DOC-2026-000902", { vendorTaxId: "82066493" });
    const r = await checkDocumentVendor(createDb(env.DB), "DOC-2026-000902");
    expect(r).toMatchObject({ matchedVendorId: null, vendorStatus: "taxid_unreadable", vendorTaxIdSource: "unreadable" });
    expect(await field("DOC-2026-000902", "vendorTaxIdNote")).toContain("檢查碼錯誤");
  });

  it("QR 與印字不一致 → 以 QR 為準、notes 有註記", async () => {
    await seedDoc("DOC-2026-000903", { vendorTaxIdQr: "82066492", vendorTaxIdPrinted: "24794037" });
    const r = await checkDocumentVendor(createDb(env.DB), "DOC-2026-000903");
    expect(r).toMatchObject({ matchedVendorId: "vnd-展蝶企業社-56d0", vendorTaxIdSource: "qr" });
    expect(await field("DOC-2026-000903", "vendorTaxIdNote")).toContain("以 QR 為準");
  });

  it("寫回 API 給 QR + 印字 → vendorTaxId 寫成 QR 的值,原始值另存", async () => {
    await seedDoc("DOC-2026-000904", {});
    const res = await post(buildApp(), "/wb/documents/DOC-2026-000904", {
      vendorTaxIdQr: "82066492",
      vendorTaxIdPrinted: "24794037",
      confidence: "high",
      source: "test",
    });
    expect(res.status).toBe(200);
    expect(await field("DOC-2026-000904", "vendorTaxId")).toBe("82066492");
    expect(await field("DOC-2026-000904", "vendorTaxIdQr")).toBe("82066492");
    expect(await field("DOC-2026-000904", "vendorTaxIdPrinted")).toBe("24794037");
  });

  it("未建檔統編 → 不對應、出現在待建檔清單;建檔後自動補對應", async () => {
    await seedDoc("DOC-2026-000905", { vendorTaxId: "24794037", vendorNameRaw: "好市多北投" }, { vendorNameRaw: "好市多北投", amountCents: 6900, invoiceDate: "2026-09-10" });
    await seedDoc("DOC-2026-000906", { vendorTaxIdQr: "24794037" }, { amountCents: 576800, invoiceDate: "2026-09-12" });
    const db = createDb(env.DB);
    expect((await checkDocumentVendor(db, "DOC-2026-000905")).vendorStatus).toBe("pending");
    expect((await checkDocumentVendor(db, "DOC-2026-000906")).vendorStatus).toBe("pending");

    const listRes = await buildApp().request("/vendors/pending", {}, env);
    const list = (await listRes.json()) as Awaited<ReturnType<typeof listPendingVendors>>;
    const group = list.pending.find((g) => g.taxId === "24794037");
    expect(group).toMatchObject({ documentCount: 2, totalCents: 583700, dateFrom: "2026-09-10", dateTo: "2026-09-12" });
    expect(group?.sources.sort()).toEqual(["printed", "qr"]);
    expect(group?.ocrNames).toContain("好市多北投");
    expect(list.unreadable.map((u) => u.documentId)).toContain("DOC-2026-000902");

    const created = await post(buildApp(), "/vendors", { name: "好市多股份有限公司 北投分公司", taxId: "24794037" });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; linkedDocumentIds: string[] };
    expect(body.linkedDocumentIds.sort()).toEqual(["DOC-2026-000905", "DOC-2026-000906"]);
    const [doc] = await db.select().from(documents).where(eq(documents.id, "DOC-2026-000905"));
    expect(doc.vendorId).toBe(body.id);
    expect(await field("DOC-2026-000905", "vendor_status")).toBe("matched");

    const after = (await (await buildApp().request("/vendors/pending", {}, env)).json()) as Awaited<ReturnType<typeof listPendingVendors>>;
    expect(after.pending.find((g) => g.taxId === "24794037")).toBeUndefined();
    // 每日排程補抓:寫回後還沒重跑 pipeline 的 000904(QR 82066492)也會被補上;再跑一次就沒有了
    expect((await backfillVendorIds(db)).map((h) => h.documentId)).toEqual(["DOC-2026-000904"]);
    expect(await backfillVendorIds(db)).toEqual([]);
  });

  it("ignored/dup 的文件不列入待建檔", async () => {
    await seedDoc("DOC-2026-000907", { vendorTaxId: "86382689" }, { status: "dup" });
    const list = await listPendingVendors(createDb(env.DB));
    expect(list.pending.find((g) => g.taxId === "86382689")).toBeUndefined();
  });

  it("修改主檔名稱:只改 D1,回傳 NAS 影響清單,不自動改檔名", async () => {
    const db = createDb(env.DB);
    await db.update(documents).set({ filedAt: "2026-09-28T00:00:00Z" }).where(eq(documents.id, "DOC-2026-000061"));
    const res = await post(buildApp(), "/vendors/vnd-展蝶企業社-56d0", { name: "展蝶企業社(新)" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nasRenameCandidates: Array<{ documentId: string; localPath: string }> };
    expect(body.nasRenameCandidates.map((c) => c.documentId)).toEqual(["DOC-2026-000061"]);
    const [f] = await db.select().from(documentFiles).where(eq(documentFiles.documentId, "DOC-2026-000061"));
    expect(f.localPath).toContain("00_收件"); // 檔案路徑沒動
    const [v] = await db.select().from(vendors).where(eq(vendors.id, "vnd-展蝶企業社-56d0"));
    expect(v.name).toBe("展蝶企業社(新)");
  });
});
