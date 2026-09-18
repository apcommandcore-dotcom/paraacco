// 關鍵路徑測試:CODE_TASK_document-fields-additions_20260918.md 新增的兩個欄位——
// itemName(品名,填 documents.display_name 預設值)、invoiceDate(發票/開立日期)。
// 重點驗證 display_name 的「已有值不覆蓋」規則(用 SQL COALESCE 在 /classify 同一個
// UPDATE 裡原子完成,不是先 SELECT 再判斷,這裡直接測行為而不是實作細節)。

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb, documents, nextId } from "@paraacco/db";
import { eq } from "drizzle-orm";
import { internalDocumentsRoute } from "../src/routes/internal/documents";

function buildApp() {
  const app = new Hono<{ Bindings: import("../src/bindings").Bindings }>();
  app.route("/internal/documents", internalDocumentsRoute);
  return app;
}

async function seedDocument() {
  const db = createDb(env.DB);
  const id = await nextId(db, "DOC", 2026);
  await db.insert(documents).values({ id, ownership: "corp", source: "api_import", status: "extract" });
  return id;
}

async function classify(app: Hono<{ Bindings: import("../src/bindings").Bindings }>, id: string, body: Record<string, unknown>) {
  return app.request(
    `/internal/documents/${id}/classify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("品名(itemName)→ documents.display_name 預設值,已有值不覆蓋", () => {
  let app: Hono<{ Bindings: import("../src/bindings").Bindings }>;

  beforeEach(() => {
    app = buildApp();
  });

  it("display_name 還是 null 時,第一次 classify 用 itemName 當預設值填入", async () => {
    const id = await seedDocument();
    const res = await classify(app, id, { amountCents: 10000, itemName: "MacBook Pro 14 吋" });
    expect(res.status).toBe(200);

    const db = createDb(env.DB);
    const [row] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
    expect(row.displayName).toBe("MacBook Pro 14 吋");
  });

  it("display_name 已經有值(先前某次 OCR 已填過)時,之後重新 classify 不會被新的 itemName 覆蓋", async () => {
    const id = await seedDocument();
    await classify(app, id, { amountCents: 10000, itemName: "第一次判讀的品名" });

    const res2 = await classify(app, id, { amountCents: 10000, itemName: "第二次判讀出不同的品名" });
    expect(res2.status).toBe(200);

    const db = createDb(env.DB);
    const [row] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
    expect(row.displayName).toBe("第一次判讀的品名");
  });

  it("display_name 已經被使用者手動編輯過時,重新 classify 不會覆蓋成 itemName", async () => {
    const id = await seedDocument();
    const db = createDb(env.DB);
    await db.update(documents).set({ displayName: "使用者手動改過的名稱" }).where(eq(documents.id, id));

    const res = await classify(app, id, { amountCents: 10000, itemName: "OCR 判讀出的品名" });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
    expect(row.displayName).toBe("使用者手動改過的名稱");
  });

  it("這次 OCR 沒擷取到 itemName(undefined)時,display_name 維持 null,不會寫入奇怪的值", async () => {
    const id = await seedDocument();
    const res = await classify(app, id, { amountCents: 10000 });
    expect(res.status).toBe(200);

    const db = createDb(env.DB);
    const [row] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
    expect(row.displayName).toBeNull();
  });
});

describe("發票日期(invoiceDate)獨立於 docDate 寫入", () => {
  it("classify 把 invoiceDate 寫進 documents.invoice_date,不影響 docDate 既有語意", async () => {
    const app = buildApp();
    const id = await seedDocument();

    const res = await classify(app, id, {
      amountCents: 10000,
      docDate: "2026-09-30", // 假設是「繳費期限」
      invoiceDate: "2026-09-18", // 單據上實際印的開立日
    });
    expect(res.status).toBe(200);

    const db = createDb(env.DB);
    const [row] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
    expect(row.docDate).toBe("2026-09-30");
    expect(row.invoiceDate).toBe("2026-09-18");
  });
});
