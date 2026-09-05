// 全域搜尋(規格 3.6)—— 接 packages/db 已經實作好的 document FTS5 全文檢索
// (searchDocumentFts,見 packages/db/src/search.ts),不是只比對文件編號/供應商/發票號碼
// 這幾個欄位的關鍵字篩選。索引涵蓋供應商名稱、發票/訂單/序號、OCR 擷取欄位的值、原始檔名。

import { Hono } from "hono";
import { inArray } from "drizzle-orm";
import { createDb, documents, searchDocumentFts } from "@paraacco/db";
import type { Bindings } from "../bindings";

export const searchRoute = new Hono<{ Bindings: Bindings }>();

searchRoute.get("/", async (c) => {
  const q = c.req.query("q") ?? "";
  const db = createDb(c.env.DB);
  const hits = await searchDocumentFts(db, q);
  if (!hits.length) return c.json({ results: [] });

  const docs = await db
    .select()
    .from(documents)
    .where(inArray(documents.id, hits.map((h) => h.documentId)));
  const byId = new Map(docs.map((d) => [d.id, d]));

  // searchDocumentFts 已經依 bm25 排好序,這裡照 hits 的順序組結果,不要用 docs 查出來的
  // 順序(inArray 不保證順序)。
  const results = hits
    .map((h) => {
      const doc = byId.get(h.documentId);
      if (!doc) return null;
      return { document: doc, snippet: h.snippet };
    })
    .filter((r): r is { document: (typeof docs)[number]; snippet: string } => r !== null);

  return c.json({ results });
});
