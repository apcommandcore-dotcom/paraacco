// document_fts 全文檢索的應用層同步/查詢 helper。
//
// document_fts 是手寫的 SQLite FTS5 虛擬表(見 migrations-manual/0001_document_fts.sql),
// 不在 drizzle 的 schema.ts 裡建模(drizzle-kit 的 sqlite-core table builder 不支援
// `CREATE VIRTUAL TABLE ... USING fts5`),所以這裡一律用 sql`` 樣板直接下 SQL,不透過
// query builder。
//
// 同步策略:不用 SQL trigger(D1 對 FTS5 + trigger 組合的支援還不夠穩定),改由呼叫端在
// document 的擷取欄位/檔案有變動時(例如 pipeline 第 4 步「擷取欄位」完成、或人工於覆核
// 畫面確認/修改欄位後)呼叫 syncDocumentFts(db, documentId) 全量重建該筆索引 —— 每次都是
// 「先刪除舊列、重新查詢最新資料、重新插入」,不做部分欄位的增量更新,邏輯簡單且對這個
// 資料量(單一事務所)完全足夠。

import { sql } from "drizzle-orm";
import type { Db } from "./client";
import { documentExtractedFields, documentFiles, documents } from "./schema";
import { eq } from "drizzle-orm";

export interface DocumentFtsRow {
  documentId: string;
  vendorName: string;
  invoiceNo: string;
  orderNo: string;
  serialNo: string;
  brand: string;
  model: string;
  extractedText: string;
  fileNames: string;
}

/** 刪除單一文件在 document_fts 裡的所有列(document_id 非唯一鍵,可能因重複同步殘留多列,故用 DELETE 而非單列 UPDATE)。 */
export async function deleteDocumentFts(db: Db, documentId: string): Promise<void> {
  await db.run(sql`DELETE FROM document_fts WHERE document_id = ${documentId}`);
}

/** 依已組好的欄位值直接寫入一列(供已經在呼叫端算好資料的情境使用,例如批次重建索引)。 */
export async function upsertDocumentFtsRow(db: Db, row: DocumentFtsRow): Promise<void> {
  await deleteDocumentFts(db, row.documentId);
  await db.run(sql`
    INSERT INTO document_fts (document_id, vendor_name, invoice_no, order_no, serial_no, brand, model, extracted_text, file_names)
    VALUES (${row.documentId}, ${row.vendorName}, ${row.invoiceNo}, ${row.orderNo}, ${row.serialNo}, ${row.brand}, ${row.model}, ${row.extractedText}, ${row.fileNames})
  `);
}

/**
 * 從 documents / document_extracted_fields / document_files 目前的資料重建單一文件的
 * document_fts 索引列。適合在 pipeline 擷取欄位完成後、或人工覆核修改欄位後呼叫。
 */
export async function syncDocumentFts(db: Db, documentId: string): Promise<void> {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc) {
    // 文件已被刪除(理論上不會發生,documents 沒有硬刪除流程,保險起見仍清索引)。
    await deleteDocumentFts(db, documentId);
    return;
  }

  const fields = await db
    .select({ value: documentExtractedFields.value, normalizedValue: documentExtractedFields.normalizedValue })
    .from(documentExtractedFields)
    .where(eq(documentExtractedFields.documentId, documentId));

  const files = await db
    .select({ originalFileName: documentFiles.originalFileName })
    .from(documentFiles)
    .where(eq(documentFiles.documentId, documentId));

  const extractedText = fields
    .flatMap((f) => [f.value, f.normalizedValue])
    .filter((v): v is string => !!v && v.trim().length > 0)
    .join(" ");

  const fileNames = files
    .map((f) => f.originalFileName)
    .filter((v): v is string => !!v && v.trim().length > 0)
    .join(" ");

  await upsertDocumentFtsRow(db, {
    documentId: doc.id,
    vendorName: doc.vendorNameRaw ?? "",
    invoiceNo: doc.invoiceNo ?? "",
    orderNo: doc.orderNo ?? "",
    serialNo: doc.serialNo ?? "",
    brand: doc.brand ?? "",
    model: doc.model ?? "",
    extractedText,
    fileNames,
  });
}

export interface DocumentFtsSearchHit {
  documentId: string;
  snippet: string;
  rank: number;
}

/**
 * 全文檢索:對 vendor_name/invoice_no/order_no/serial_no/brand/model/extracted_text/file_names
 * 做 FTS5 MATCH,依 bm25 排序,回傳 document_id + 命中片段摘要(供搜尋結果列表顯示,見規格文件
 * 3.4 全域搜尋)。呼叫端再用回傳的 document_id 去查 documents 表組完整結果。
 */
export async function searchDocumentFts(db: Db, query: string, limit = 20): Promise<DocumentFtsSearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // FTS5 query syntax 對使用者輸入的特殊字元(例如中文標點、半形符號)可能會噴語法錯誤,
  // 用雙引號包成 phrase query 是最安全的作法,讓使用者輸入被當純文字比對,不解讀成 FTS5 運算子。
  const phraseQuery = `"${trimmed.replace(/"/g, '""')}"`;

  const rows = await db.all<{ document_id: string; snippet: string; rank: number }>(sql`
    SELECT
      document_id,
      snippet(document_fts, 7, '[', ']', '…', 10) AS snippet,
      bm25(document_fts) AS rank
    FROM document_fts
    WHERE document_fts MATCH ${phraseQuery}
    ORDER BY rank
    LIMIT ${limit}
  `);

  return rows.map((r) => ({ documentId: r.document_id, snippet: r.snippet, rank: r.rank }));
}
