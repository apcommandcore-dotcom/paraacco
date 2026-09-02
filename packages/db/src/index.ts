// @paraacco/db
// D1 schema 與 query 層,web/api/document-worker 共用同一份 schema(採購/資產/文件)。
// 對應規格文件(paraacco-integration/vaultlink-v2-design-spec-20260902.md)第 2 節、缺口清單第 1 點。
//
// 邊界提醒(見根目錄 README、apps/document-worker/wrangler.toml 註解):
// document-worker 不掛 D1 binding,一律呼叫 apps/api 的 /api/documents/:id/ocr-result 端點回寫結果,
// 不直接 import 這個套件的 write 操作。

export * from "./schema";
export * from "./client";
export * from "./sequences";
