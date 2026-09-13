// 對帳單明細列(人類使用者端)—— 架構文件第 6 節「對帳頁」用,列出 statement_lines,標示
// 已勾稽/建議勾稽·待確認/未勾稽,可看對應的採購案/憑證文件。寫入(落地明細列、比對)一律由
// document-worker 走 /internal/statement-lines/*(見 routes/internal/statement-lines.ts),
// 這支路由只做人類覆核用的讀取跟「人工確認/修正比對結果」兩件事。

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { createDb, purchases, statementLines } from "@paraacco/db";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";

export const statementLinesRoute = new Hono<{ Bindings: Bindings }>();

statementLinesRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const status = c.req.query("status");
  const entityId = c.req.query("entityId");
  const conditions = [
    status ? eq(statementLines.reconciliationStatus, status) : undefined,
    entityId ? eq(statementLines.entityId, entityId) : undefined,
  ].filter((v) => v !== undefined);

  const rows = await db
    .select({
      id: statementLines.id,
      entityId: statementLines.entityId,
      sourceDocumentId: statementLines.sourceDocumentId,
      date: statementLines.date,
      amountCents: statementLines.amountCents,
      description: statementLines.description,
      reconciliationStatus: statementLines.reconciliationStatus,
      matchedPurchaseId: statementLines.matchedPurchaseId,
      matchConfidence: statementLines.matchConfidence,
      matchNote: statementLines.matchNote,
      createdAt: statementLines.createdAt,
      matchedPurchaseSummary: purchases.summary,
      matchedPurchaseVendor: purchases.vendorNameRaw,
    })
    .from(statementLines)
    .leftJoin(purchases, eq(statementLines.matchedPurchaseId, purchases.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(statementLines.date));

  return c.json({ statementLines: rows });
});

// 人工在對帳頁手動修正比對結果(例如系統判斷 unmatched,但人工確認其實是某筆採購案的現金
// 交易之外的正常扣款)——直接指定 purchaseId 就標記 matched,不帶 purchaseId 就標記
// unmatched,不需要另外重跑比對演算法(人工判斷優先於自動比對結果)。
statementLinesRoute.post("/:id/confirm", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ purchaseId?: string }>();

  const db = createDb(c.env.DB);
  await db
    .update(statementLines)
    .set({
      reconciliationStatus: body.purchaseId ? "matched" : "unmatched",
      matchedPurchaseId: body.purchaseId ?? null,
      matchConfidence: body.purchaseId ? 100 : null,
      matchNote: "人工確認",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(statementLines.id, id));

  return c.json({ ok: true });
});
