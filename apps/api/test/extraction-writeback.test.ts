// 關鍵路徑測試:CODE_TASK_extraction-writeback-api_20260923.md 階段二 B 項——擷取結果寫回
// 端點的 7 條必要行為(冪等、金額整數、狀態 review、信心度、稽核、不覆蓋人工確認值、
// 部分失敗要明確),以及 Q3 決議的「待擷取文件」查詢(資料庫實際狀態,不是 pipeline 進度)。
// 不測 middleware/extraction-writeback-auth.ts 本身(共用密鑰比對,邏輯跟
// middleware/batch-auth.ts 一樣簡單,不需要重複測),只測 extractionWritebackRoute 的業務
// 邏輯,做法跟 test/document-fields-additions.test.ts 一樣直接掛 route、不經過正式 middleware。

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb, documentExtractedFields, documentFiles, documents, nextId } from "@paraacco/db";
import { eq } from "drizzle-orm";
import { extractionWritebackRoute } from "../src/routes/extraction-writeback";
import type { Bindings } from "../src/bindings";

function buildApp() {
  const app = new Hono<{ Bindings: Bindings }>();
  app.route("/", extractionWritebackRoute);
  return app;
}

async function seedDocument(status = "queued") {
  const db = createDb(env.DB);
  const id = await nextId(db, "DOC", 2026);
  await db.insert(documents).values({ id, ownership: "corp", source: "api_import", status });
  return id;
}

async function seedOriginalFile(documentId: string) {
  const db = createDb(env.DB);
  await db.insert(documentFiles).values({
    documentId,
    kind: "original",
    r2Key: `documents/${documentId}/original/v1/test.pdf`,
    originalFileName: "test.pdf",
    mimeType: "application/pdf",
    byteSize: 123,
    isCurrent: true,
  });
}

function writeback(app: Hono<{ Bindings: Bindings }>, id: string, body: Record<string, unknown>) {
  return app.request(
    `/documents/${id}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    env,
  );
}

const VALID_BODY = {
  invoiceNo: "TW-97275013",
  invoiceDate: "2025-12-24",
  invoicePeriod: "114年11-12月",
  vendorTaxId: "83356933",
  vendorNameRaw: "測試商店",
  ownership: "corp",
  amountCents: 51000, // 510 元,2026-09-24 決議:輸入本身就是整數分,不是元
  taxableAmountCents: 48600,
  taxAmountCents: 2400,
  confidence: "high" as const,
  source: "Claude 對話判讀",
};

describe("POST /documents/:id —— 基本寫入", () => {
  let app: Hono<{ Bindings: Bindings }>;
  beforeEach(() => {
    app = buildApp();
  });

  it("文件不存在回 404", async () => {
    const res = await writeback(app, "DOC-2026-999999", VALID_BODY);
    expect(res.status).toBe(404);
  });

  it("寫入 documents 直欄 + document_extracted_fields,狀態轉 review,不會自動 archived", async () => {
    const id = await seedDocument();
    const res = await writeback(app, id, VALID_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; written: string[]; skippedUserConfirmed: string[] };
    expect(body.ok).toBe(true);
    expect(body.written).toEqual(expect.arrayContaining(["invoiceNo", "invoiceDate", "vendorNameRaw", "amountCents"]));
    expect(body.skippedUserConfirmed).toEqual([]);

    const db = createDb(env.DB);
    const [doc] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
    expect(doc.status).toBe("review");
    expect(doc.invoiceNo).toBe("TW-97275013");
    expect(doc.vendorNameRaw).toBe("測試商店");
    expect(doc.amountCents).toBe(51000); // 輸入即整數分,原封不動寫入,沒有單位換算
    expect(doc.ocrConfidence).toBe(90); // high
    expect(doc.ownership).toBe("corp");
    expect(doc.ownershipConfirmed).toBe(true); // 2026-09-24 決議:傳了 ownership 就視為已確認

    const fields = await db.select().from(documentExtractedFields).where(eq(documentExtractedFields.documentId, id));
    const byKey = new Map(fields.map((f) => [f.fieldKey, f]));
    expect(byKey.get("amountCents")?.extractionSource).toBe("ai_inference");
    expect(byKey.get("amountCents")?.sourceNote).toBe("外部擷取:Claude 對話判讀");
    expect(byKey.get("amountCents")?.normalizedValue).toBe("51000");
    // invoicePeriod/vendorTaxId 統一用內部既有的 camelCase 鍵(V1.02 修正),不是
    // SPEC V1.01 原文的 invoice_period/seller_tax_id。
    expect(byKey.get("invoicePeriod")?.value).toBe("114年11-12月");
    expect(byKey.get("vendorTaxId")?.value).toBe("83356933");
    // taxable_amount 是 SPEC 全新概念,沒有既有同義鍵,維持 snake_case。
    expect(byKey.get("taxable_amount")?.normalizedValue).toBe("48600");
  });

  it("冪等:同一份文件重複寫入同樣內容,不會長出重複的 field rows(upsert 不是 delete+insert)", async () => {
    const id = await seedDocument();
    await writeback(app, id, VALID_BODY);
    const res2 = await writeback(app, id, VALID_BODY);
    expect(res2.status).toBe(200);

    const db = createDb(env.DB);
    const fields = await db.select().from(documentExtractedFields).where(eq(documentExtractedFields.documentId, id));
    const keys = fields.map((f) => f.fieldKey);
    expect(new Set(keys).size).toBe(keys.length); // 沒有重複 fieldKey
  });

  it("金額是浮點數一律拒絕,回 400,不自行四捨五入", async () => {
    const id = await seedDocument();
    const res = await writeback(app, id, { ...VALID_BODY, amountCents: 51000.5 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; fields: string[] };
    expect(body.error).toBe("invalid_amount");
    expect(body.fields).toContain("amountCents");

    const db = createDb(env.DB);
    const [doc] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
    expect(doc.amountCents).toBeNull(); // 整批拒絕,完全沒有寫入
  });

  it("ownership 不合法值回 400", async () => {
    const id = await seedDocument();
    const res = await writeback(app, id, { ...VALID_BODY, ownership: "not_a_real_value" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_ownership");
  });

  it("confidence 缺漏或不合法回 400", async () => {
    const id = await seedDocument();
    const { confidence: _confidence, ...rest } = VALID_BODY;
    const res = await writeback(app, id, rest);
    expect(res.status).toBe(400);
  });

  it("不覆蓋已人工確認的欄位,回應中列出被跳過的欄位", async () => {
    const id = await seedDocument();
    const db = createDb(env.DB);
    // 模擬這份文件先前已經有人工確認過的 vendorNameRaw——document_extracted_fields 那一列
    // isUserConfirmed=true,promote 到 documents 直欄的值也已經是同一個確認過的值。
    await db.update(documents).set({ vendorNameRaw: "人工確認過的正確商店名" }).where(eq(documents.id, id));
    await db.insert(documentExtractedFields).values({
      documentId: id,
      fieldKey: "vendorNameRaw",
      label: "供應商",
      value: "人工確認過的正確商店名",
      extractionSource: "user_input",
      isUserConfirmed: true,
    });

    const res = await writeback(app, id, VALID_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { written: string[]; skippedUserConfirmed: string[] };
    expect(body.skippedUserConfirmed).toContain("vendorNameRaw");
    expect(body.written).not.toContain("vendorNameRaw");

    const [doc] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
    expect(doc.vendorNameRaw).toBe("人工確認過的正確商店名"); // 沒被覆蓋
    const fields = await db.select().from(documentExtractedFields).where(eq(documentExtractedFields.documentId, id));
    const vendorField = fields.find((f) => f.fieldKey === "vendorNameRaw");
    expect(vendorField?.value).toBe("人工確認過的正確商店名");
    expect(vendorField?.isUserConfirmed).toBe(true);
  });

  it("SPEC V1.06 R11:documentRole / accountNumber / billingMonth 寫入欄位,值不合法回 400", async () => {
    const id = await seedDocument();
    const ok = await writeback(app, id, { ...VALID_BODY, documentRole: "bill", accountNumber: "C108001950", billingMonth: "2026-08" });
    expect(ok.status).toBe(200);
    const rows = await createDb(env.DB).select().from(documentExtractedFields).where(eq(documentExtractedFields.documentId, id));
    const by = new Map(rows.map((r) => [r.fieldKey, r.value]));
    expect(by.get("document_role")).toBe("bill");
    expect(by.get("accountNumber")).toBe("C108001950");
    expect(by.get("billing_month")).toBe("2026-08");
    expect((await writeback(app, id, { ...VALID_BODY, documentRole: "receipt" })).status).toBe(400);
    expect((await writeback(app, id, { ...VALID_BODY, billingMonth: "2026/08" })).status).toBe(400);
  });

  it("每次寫入都留下 activity_log 稽核紀錄", async () => {
    const id = await seedDocument();
    await writeback(app, id, VALID_BODY);

    const db = createDb(env.DB);
    const { activityLog } = await import("@paraacco/db");
    const logs = await db.select().from(activityLog).where(eq(activityLog.entityId, id));
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].kind).toBe("ocr");
    expect(logs[0].text).toContain("Claude 對話判讀");
  });
});

// 2026-09-24 你要求的驗收測試(commit 前必須通過,最重要的一組):證明「擷取過的文件不會
// 被重複處理」——這是整條流程能不能分批跑的前提。三步驟串在同一個測試裡,依序驗證:
//   a. 同一份文件連續寫回兩次相同內容 → document_extracted_fields 沒有產生重複 row。
//   b. 寫回後,待擷取文件清單裡不再出現這份文件。
//   c. 修改其中一個欄位再寫回第三次 → 值有更新、row 數沒變(不是刪除重建)。
describe("驗收測試:擷取過的文件不會被重複處理(commit 前必須通過)", () => {
  it("同內容重複寫回不長出重複列 → 待擷取清單移除 → 改欄位再寫回只更新不增列", async () => {
    const app = buildApp();
    const id = await seedDocument();
    await seedOriginalFile(id);

    // 寫回前:待擷取清單裡看得到。
    const before = await app.request("/documents?limit=500", {}, env);
    const beforeBody = (await before.json()) as { documents: Array<{ id: string }> };
    expect(beforeBody.documents.map((d) => d.id)).toContain(id);

    // --- a. 第一次、第二次寫回同樣內容 ---
    const res1 = await writeback(app, id, VALID_BODY);
    expect(res1.status).toBe(200);
    const db = createDb(env.DB);
    const fieldsAfter1 = await db.select().from(documentExtractedFields).where(eq(documentExtractedFields.documentId, id));
    const rowCountAfter1 = fieldsAfter1.length;
    expect(rowCountAfter1).toBeGreaterThan(0);

    const res2 = await writeback(app, id, VALID_BODY);
    expect(res2.status).toBe(200);
    const fieldsAfter2 = await db.select().from(documentExtractedFields).where(eq(documentExtractedFields.documentId, id));
    expect(fieldsAfter2.length).toBe(rowCountAfter1); // row 數沒變
    const keysAfter2 = fieldsAfter2.map((f) => f.fieldKey);
    expect(new Set(keysAfter2).size).toBe(keysAfter2.length); // 沒有重複 fieldKey
    const amountFieldAfter2 = fieldsAfter2.find((f) => f.fieldKey === "amountCents");
    expect(amountFieldAfter2?.value).toBe("51000");

    // --- b. 待擷取清單裡這份文件應該消失 ---
    const pendingAfterWriteback = await app.request("/documents?limit=500", {}, env);
    const pendingBody = (await pendingAfterWriteback.json()) as { documents: Array<{ id: string }> };
    expect(pendingBody.documents.map((d) => d.id)).not.toContain(id);

    // --- c. 改一個欄位再寫回第三次:值要更新,row 數不能變 ---
    const res3 = await writeback(app, id, { ...VALID_BODY, amountCents: 99900 });
    expect(res3.status).toBe(200);
    const fieldsAfter3 = await db.select().from(documentExtractedFields).where(eq(documentExtractedFields.documentId, id));
    expect(fieldsAfter3.length).toBe(rowCountAfter1); // row 數還是沒變
    const amountFieldAfter3 = fieldsAfter3.find((f) => f.fieldKey === "amountCents");
    expect(amountFieldAfter3?.value).toBe("99900"); // 值真的更新了
    const [docAfter3] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
    expect(docAfter3.amountCents).toBe(99900);
  });
});

describe("GET /documents —— 待擷取文件(資料庫實際狀態,不是 pipeline 進度)", () => {
  it("回傳有原檔、但沒有任何白名單擷取欄位的文件;不管 documents.status 是什麼", async () => {
    const app = buildApp();
    const pendingId = await seedDocument("review"); // 故意用 review 狀態,證明不是看 status
    await seedOriginalFile(pendingId);

    const extractedId = await seedDocument("queued");
    await seedOriginalFile(extractedId);
    const db = createDb(env.DB);
    await db.insert(documentExtractedFields).values({
      documentId: extractedId,
      fieldKey: "invoiceNo",
      label: "發票號碼",
      value: "ALREADY-EXTRACTED",
      extractionSource: "ai_inference",
    });

    const noFileId = await seedDocument("queued"); // 沒有原檔,不該出現

    const res = await app.request("/documents?limit=50", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documents: Array<{ id: string }> };
    const ids = body.documents.map((d) => d.id);
    expect(ids).toContain(pendingId);
    expect(ids).not.toContain(extractedId);
    expect(ids).not.toContain(noFileId);
  });

  it("_ocr_status 佔位欄位(EXTRACTION_MODE=external 的等待中文件)不算已擷取,仍會出現在待擷取清單", async () => {
    const app = buildApp();
    const id = await seedDocument("review");
    await seedOriginalFile(id);
    const db = createDb(env.DB);
    await db.insert(documentExtractedFields).values({
      documentId: id,
      fieldKey: "_ocr_status",
      label: "OCR 狀態",
      value: "awaiting_external_extraction",
      extractionSource: "ai_inference",
    });

    const res = await app.request("/documents?limit=50", {}, env);
    const body = (await res.json()) as { documents: Array<{ id: string }> };
    expect(body.documents.map((d) => d.id)).toContain(id);
  });
});

describe("POST /documents/:id/normalized-file —— 裁切轉正後的顯示檔(2026-09-26)", () => {
  const PDF = new TextEncoder().encode("%PDF-1.4\n% test normalized\n%%EOF\n");

  function upload(app: Hono<{ Bindings: Bindings }>, id: string, body: Uint8Array | string, contentType = "application/pdf") {
    return app.request(`/documents/${id}/normalized-file`, { method: "POST", headers: { "Content-Type": contentType }, body }, env);
  }

  it("存成 normalized_pdf,original 不動;同內容重傳冪等", async () => {
    const app = buildApp();
    const id = await seedDocument("review");
    await seedOriginalFile(id);

    const res = await upload(app, id, PDF);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; unchanged: boolean; r2Key: string };
    expect(body.unchanged).toBe(false);
    expect(await env.FILES.get(body.r2Key)).not.toBeNull();

    const again = await upload(app, id, PDF);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { unchanged: boolean }).unchanged).toBe(true);

    const files = await createDb(env.DB).select().from(documentFiles).where(eq(documentFiles.documentId, id));
    expect(files.filter((f) => f.kind === "original" && f.isCurrent)).toHaveLength(1);
    expect(files.filter((f) => f.kind === "normalized_pdf")).toHaveLength(1);
  });

  it("內容不同時,舊的 normalized_pdf 標 isCurrent=false,只留一份 current", async () => {
    const app = buildApp();
    const id = await seedDocument("review");
    await seedOriginalFile(id);
    await upload(app, id, PDF);
    await upload(app, id, new TextEncoder().encode("%PDF-1.4\n% v2\n%%EOF\n"));
    const files = await createDb(env.DB).select().from(documentFiles).where(eq(documentFiles.documentId, id));
    const normalized = files.filter((f) => f.kind === "normalized_pdf");
    expect(normalized).toHaveLength(2);
    expect(normalized.filter((f) => f.isCurrent)).toHaveLength(1);
  });

  it("非 PDF / 錯的 Content-Type / 文件不存在 / 沒有原檔 都拒絕", async () => {
    const app = buildApp();
    const id = await seedDocument("review");
    expect((await upload(app, id, PDF)).status).toBe(409); // 還沒有 original
    await seedOriginalFile(id);
    expect((await upload(app, id, "not a pdf")).status).toBe(400);
    expect((await upload(app, id, PDF, "image/jpeg")).status).toBe(415);
    expect((await upload(app, "DOC-2026-999998", PDF)).status).toBe(404);
  });
});
