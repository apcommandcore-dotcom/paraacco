// /internal/statement-lines/* —— 憑證 × 對帳單自動勾稽(架構文件第 5 節)。跟
// routes/internal/documents.ts 一樣只給 document-worker 透過 Service Binding 呼叫,套用
// internalAuthMiddleware(見 apps/api/src/index.ts)。
//
// POST /documents/:documentId — 對帳單文件的 Gemini 判讀結果(明細列陣列)落地寫進
// statement_lines,每一列立刻跑一次比對(見 @paraacco/domain 的 matchStatementLine())。
// 故意用 /documents/:documentId 不是裸的 /:documentId——避免跟下面 /reconcile-pending
// 這個字面路徑在 Hono 的路由比對順序上互相打架(裸的 param route 會把 "reconcile-pending"
// 當成 documentId 吃掉)。
// POST /reconcile-pending — 重新比對所有還沒 matched 的列,實際邏輯在 ../../reconciliation.ts
// (跟 apps/api/src/scheduled.ts 的每日排程共用同一份,見該檔案註解)。

import { Hono } from "hono";
import { createDb, statementLines } from "@paraacco/db";
import { matchStatementLine } from "@paraacco/domain";
import type { Bindings } from "../../bindings";
import { candidatesForEntity, reconcilePendingStatementLines } from "../../reconciliation";

export const internalStatementLinesRoute = new Hono<{ Bindings: Bindings }>();

internalStatementLinesRoute.post("/documents/:documentId", async (c) => {
  const documentId = c.req.param("documentId");
  const body = await c.req.json<{
    entityId: string;
    lines: Array<{ date: string; amountCents: number; description: string }>;
  }>();

  const db = createDb(c.env.DB);
  const candidates = await candidatesForEntity(db, body.entityId);

  const insertedIds: number[] = [];
  for (const line of body.lines) {
    const result = matchStatementLine({ amountCents: line.amountCents, date: line.date }, line.description, candidates);
    const [row] = await db
      .insert(statementLines)
      .values({
        entityId: body.entityId,
        sourceDocumentId: documentId,
        date: line.date,
        amountCents: line.amountCents,
        description: line.description,
        reconciliationStatus: result.status,
        matchedPurchaseId: result.purchaseId,
        matchConfidence: result.confidence,
        matchNote: result.note,
      })
      .returning({ id: statementLines.id });
    if (row) insertedIds.push(row.id);
  }

  return c.json({ ok: true, count: insertedIds.length, ids: insertedIds });
});

internalStatementLinesRoute.post("/reconcile-pending", async (c) => {
  const db = createDb(c.env.DB);
  const result = await reconcilePendingStatementLines(db);
  return c.json({ ok: true, ...result });
});
