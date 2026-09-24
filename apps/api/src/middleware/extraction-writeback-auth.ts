// 擷取結果寫回驗證 middleware —— 只給「pipeline 之外完成擷取判讀」的呼叫端(目前是 Theo 在
// Claude 對話中手動判讀後呼叫,未來可能換成 Gemini 付費 API 的 server-side 呼叫)用,呼叫
// /api/extraction-writeback/* 用。
//
// 不是給人類使用者用的(人類走 Cloudflare Access,見 auth.ts)。不是給批次進件排程腳本用的
// (那個走 batch-auth.ts,故意用不同密鑰——見 CODE_REPORT_extraction-writeback-api-phase1_
// 20260923.md Q4:寫回的權限範圍是「改既有文件的擷取欄位/狀態」,批次進件是「新增文件」,
// 性質不同,合用同一把密鑰會讓任一邊外洩時的影響範圍擴大)。也不是給 document-worker 用的
// (那個走 internal-auth.ts,只能透過 Service Binding 呼叫,絕不能掛公開網域——寫回端點
// 必然要對公開網域開放,用途不符)。
//
// 跟 batch-import 一樣,呼叫端在 Cloudflare 網路之外打公開 HTTPS 進來,一定會先經過
// Cloudflare Access 邊緣檢查——這個 middleware 只負責 Worker 內部這一層(共用密鑰比對),
// 還需要在 Cloudflare Zero Trust 對 `/api/extraction-writeback/*` 這條路徑另外設一條 Bypass
// 政策,否則請求連 Worker 都到不了(做法跟 routes/batch-import.ts 開頭說明的一樣)。

import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../bindings";

export function extractionWritebackAuthMiddleware(): MiddlewareHandler<{ Bindings: Bindings }> {
  return async (c, next) => {
    const token = c.req.header("X-Extraction-Writeback-Token");
    if (!token || token !== c.env.EXTRACTION_WRITEBACK_TOKEN) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  };
}
