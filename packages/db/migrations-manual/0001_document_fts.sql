-- packages/db/migrations-manual/0001_document_fts.sql
--
-- SQLite FTS5 全文檢索表,供文件 OCR 內容搜尋用(規格文件 3.4 全域搜尋)。
-- drizzle-kit 的 sqlite-core table builder 不支援 `CREATE VIRTUAL TABLE ... USING fts5`,
-- 所以這張表不放進 packages/db/src/schema.ts,改用這份手寫 SQL 管理,跟 seed.sql 一樣
-- 不會被 `wrangler d1 migrations apply` 自動套用,要手動執行一次:
--
--   npx wrangler d1 execute paraacco-db --remote --file=./migrations-manual/0001_document_fts.sql
--
-- 或貼到 Cloudflare Dashboard → D1 → paraacco-db → Console 執行。
--
-- 設計為「獨立 FTS5 表」(非 external content 模式):document_id 只是一般欄位、不是
-- SQLite 的 rowid 對應鍵,同步邏輯(見 packages/db/src/search.ts 的 upsertDocumentFts()/
-- deleteDocumentFts())一律先刪除該 document_id 的舊列再重新插入,不用 SQL trigger 維護,
-- 因為 D1 目前對 FTS5 + trigger 的組合支援還不夠穩定,應用層同步比較可控。
--
-- 索引內容涵蓋:供應商名稱、文件辨識欄位(發票/訂單/序號)、OCR 擷取欄位的值、原始檔名 ——
-- 對應 documents 表與 document_extracted_fields / document_files 表(見 schema.ts)。

CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(
  document_id UNINDEXED,
  vendor_name,
  invoice_no,
  order_no,
  serial_no,
  brand,
  model,
  extracted_text,
  file_names,
  tokenize = 'unicode61 remove_diacritics 2'
);
