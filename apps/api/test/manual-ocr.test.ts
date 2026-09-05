// 關鍵路徑測試 1/2:人工 OCR 覆蓋機制(見
// CODE_TASK_manual-ocr-pipeline-integration_20260904.md)——POST /api/documents 帶
// extractedFields 時,伺服器端要強制把 extractionSource 寫成 'user_input',不能相信
// client 傳來的值(這是這條機制最重要的安全性質:偽造成看起來像自動 OCR 高信心結果的
// 攻擊要在這一關就被擋下來)。

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, documentExtractedFields, members } from "@paraacco/db";
import { eq } from "drizzle-orm";
import { buildTestApp, TEST_AUTH } from "./helpers";

describe("POST /api/documents extractedFields → user_input 覆蓋機制", () => {
  // documents.created_by_member_id 有 FK 指到 members.id——先種一筆對應假 auth 的
  // member 列(見 helpers.ts 的 TEST_AUTH)。用 beforeAll 不是 beforeEach:同一個測試
  // 檔案裡的多個 it() 共用同一個 D1 實例(@cloudflare/vitest-plugin 是「每個檔案」隔離,
  // 不是「每個 test」隔離),beforeEach 會導致第二個 it() 開始撞 email UNIQUE constraint。
  beforeAll(async () => {
    const db = createDb(env.DB);
    await db.insert(members).values({
      id: TEST_AUTH.memberId!,
      email: TEST_AUTH.email!,
      name: TEST_AUTH.name!,
      role: TEST_AUTH.role!,
      scope: TEST_AUTH.scope!,
    });
  });

  it("寫入的欄位 extraction_source 一律是 user_input,即使 client 沒有傳這個值", async () => {
    const app = buildTestApp();

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ownership: "corp",
        fileName: "test-invoice.pdf",
        mimeType: "application/pdf",
        byteSize: 12345,
        r2Key: "documents/test/original/v1/test-invoice.pdf",
        source: "api_import",
        extractedFields: [
          { fieldKey: "vendorNameRaw", label: "供應商", value: "測試供應商", confidence: 100 },
          { fieldKey: "amountCents", label: "金額", value: "100000", confidence: 100 },
        ],
      }),
    }, env);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: true; id: string };
    expect(body.ok).toBe(true);

    const db = createDb(env.DB);
    const fields = await db.select().from(documentExtractedFields).where(eq(documentExtractedFields.documentId, body.id));

    expect(fields).toHaveLength(2);
    for (const f of fields) {
      expect(f.extractionSource).toBe("user_input");
    }
    const vendorField = fields.find((f) => f.fieldKey === "vendorNameRaw");
    expect(vendorField?.value).toBe("測試供應商");
  });

  it("client 傳偽造的 extractionSource 值也會被蓋掉,不會被採信", async () => {
    const app = buildTestApp();

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ownership: "corp",
        fileName: "spoofed.pdf",
        mimeType: "application/pdf",
        byteSize: 1,
        r2Key: "documents/test/original/v1/spoofed.pdf",
        source: "api_import",
        // 故意夾帶一個不在 body type 定義裡的欄位,模擬有人手動組 request 想蓋成
        // ai_inference——路由的 zod/型別解析只認 fieldKey/label/value/confidence,
        // 這個欄位理論上會被忽略,extractionSource 依然強制是 user_input。
        extractedFields: [{ fieldKey: "invoiceNo", label: "發票號碼", value: "FORGED-001", extractionSource: "ai_inference" }],
      }),
    }, env);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: true; id: string };

    const db = createDb(env.DB);
    const fields = await db.select().from(documentExtractedFields).where(eq(documentExtractedFields.documentId, body.id));
    expect(fields[0]?.extractionSource).toBe("user_input");
  });

  it("沒有帶 extractedFields 時完全不寫入任何欄位(維持原本自動 OCR 的行為不受影響)", async () => {
    const app = buildTestApp();

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ownership: "corp",
        fileName: "auto-ocr.pdf",
        mimeType: "application/pdf",
        byteSize: 1,
        r2Key: "documents/test/original/v1/auto-ocr.pdf",
        source: "web_upload",
      }),
    }, env);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: true; id: string };

    const db = createDb(env.DB);
    const fields = await db.select().from(documentExtractedFields).where(eq(documentExtractedFields.documentId, body.id));
    expect(fields).toHaveLength(0);
  });
});
