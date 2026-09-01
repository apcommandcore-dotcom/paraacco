// 重要邊界:這個 worker 不可直接寫 D1。所有寫入(OCR 結果、文件狀態更新)一律呼叫
// apps/api 既有的端點,確保寫入路徑有統一的驗證與稽核記錄(呼應 paraarch 的設計原則)。
//
// 待補:R2 上傳觸發、OCR pipeline(@paraacco/ocr)、呼叫 api 寫回結果。

export default {
  async fetch(): Promise<Response> {
    return new Response("paraacco-document-worker: not yet implemented", {
      status: 501,
    });
  },
};
