// 關鍵路徑測試:憑證 × 對帳單自動勾稽(架構文件第 4、5 節)——落地明細列時立刻跑一次比對,
// 涵蓋 matched/suggested/unmatched 三種結果,以及 reconcile-pending 重新比對後能從
// unmatched 變成 matched(candidate purchase 是明細列落地「之後」才建立的情境)。

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb, documents, entities, nextId, purchases, statementLines } from "@paraacco/db";
import { eq } from "drizzle-orm";
import type { Bindings } from "../src/bindings";
import { internalStatementLinesRoute } from "../src/routes/internal/statement-lines";

function buildInternalTestApp() {
  const app = new Hono<{ Bindings: Bindings }>();
  app.route("/", internalStatementLinesRoute);
  return app;
}

async function seedEntity(id = "ap") {
  const db = createDb(env.DB);
  await db.insert(entities).values({ id, name: "測試法人" }).onConflictDoNothing();
  return id;
}

async function seedStatementDocument() {
  const db = createDb(env.DB);
  const id = await nextId(db, "DOC", 2026);
  await db.insert(documents).values({ id, ownership: "corp", source: "api_import", status: "review" });
  return id;
}

async function seedPurchase(entityId: string, opts: { amountCents: number; purchaseDate: string; vendorNameRaw: string }) {
  const db = createDb(env.DB);
  const id = await nextId(db, "PUR", 2026);
  await db.insert(purchases).values({
    id,
    ownership: "corp",
    entityId,
    purchaseDate: opts.purchaseDate,
    vendorNameRaw: opts.vendorNameRaw,
    summary: "測試採購案",
    amountCents: opts.amountCents,
  });
  return id;
}

describe("憑證 × 對帳單自動勾稽", () => {
  beforeEach(async () => {
    const db = createDb(env.DB);
    await db.delete(statementLines);
    await db.delete(purchases);
    await db.delete(documents);
  });

  it("金額+日期+供應商都相符 → matched", async () => {
    const entityId = await seedEntity();
    const purchaseId = await seedPurchase(entityId, { amountCents: 50000, purchaseDate: "2026-09-05", vendorNameRaw: "測試商店" });
    const docId = await seedStatementDocument();

    const app = buildInternalTestApp();
    const res = await app.request(
      `/documents/${docId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId, lines: [{ date: "2026-09-06", amountCents: 50000, description: "測試商店" }] }),
      },
      env,
    );
    expect(res.status).toBe(200);

    const db = createDb(env.DB);
    const [line] = await db.select().from(statementLines).where(eq(statementLines.sourceDocumentId, docId));
    expect(line.reconciliationStatus).toBe("matched");
    expect(line.matchedPurchaseId).toBe(purchaseId);
  });

  it("金額相符但日期差太多 → suggested", async () => {
    const entityId = await seedEntity();
    await seedPurchase(entityId, { amountCents: 30000, purchaseDate: "2026-08-01", vendorNameRaw: "測試商店" });
    const docId = await seedStatementDocument();

    const app = buildInternalTestApp();
    await app.request(
      `/documents/${docId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId, lines: [{ date: "2026-09-06", amountCents: 30000, description: "測試商店" }] }),
      },
      env,
    );

    const db = createDb(env.DB);
    const [line] = await db.select().from(statementLines).where(eq(statementLines.sourceDocumentId, docId));
    expect(line.reconciliationStatus).toBe("suggested");
  });

  it("沒有金額相符的採購案 → unmatched,之後補建立對應採購案,reconcile-pending 能補成 matched", async () => {
    const entityId = await seedEntity();
    const docId = await seedStatementDocument();

    const app = buildInternalTestApp();
    await app.request(
      `/documents/${docId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId, lines: [{ date: "2026-09-06", amountCents: 12345, description: "遲到的採購案" }] }),
      },
      env,
    );

    const db = createDb(env.DB);
    let [line] = await db.select().from(statementLines).where(eq(statementLines.sourceDocumentId, docId));
    expect(line.reconciliationStatus).toBe("unmatched");

    const purchaseId = await seedPurchase(entityId, { amountCents: 12345, purchaseDate: "2026-09-06", vendorNameRaw: "遲到的採購案" });

    const reconcileRes = await app.request("/reconcile-pending", { method: "POST" }, env);
    expect(reconcileRes.status).toBe(200);
    const reconcileBody = await reconcileRes.json();
    expect(reconcileBody.updated).toBe(1);

    [line] = await db.select().from(statementLines).where(eq(statementLines.sourceDocumentId, docId));
    expect(line.reconciliationStatus).toBe("matched");
    expect(line.matchedPurchaseId).toBe(purchaseId);
  });
});
