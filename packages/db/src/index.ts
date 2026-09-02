// @paraacco/db
// D1 schema 與 query 層,web/api/document-worker 共用同一份 schema(採購/資產/文件)。
// 對應規格文件(paraacco-integration/vaultlink-v2-design-spec-20260902.md)第 2 節。
//
// 邊界提醒(見根目錄 README、apps/document-worker/wrangler.toml 註解):
// document-worker 不掛 D1 binding,Workflow 步驟一律透過 Service Binding 呼叫 apps/api 的
// /internal/* 端點回寫結果,不直接 import 這個套件對 D1 的 write 操作。
//
// document_fts(SQLite FTS5 全文檢索表)是手寫 SQL 管理的虛擬表,不在 schema.ts 裡建模,
// 見 migrations-manual/0001_document_fts.sql 與 search.ts。

export * from "./schema";
export * from "./client";
export * from "./sequences";
export * from "./search";
