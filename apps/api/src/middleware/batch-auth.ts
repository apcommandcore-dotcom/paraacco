// 每日批次進件驗證 middleware —— 只給 Theo 的本機/NAS 排程腳本呼叫 /api/batch-import/*
// 用,不是給人類使用者用的(人類走 Cloudflare Access,見 auth.ts),也不是給
// document-worker 用的(那個走 internal-auth.ts,不同密鑰)。
//
// 排程腳本跑在 Cloudflare 網路之外的一般機器上,一定要真的打一次 HTTPS 到
// acco-api.parallelserver.org,會先經過 Cloudflare Access 的邊緣檢查——這個 middleware
// 本身只負責 Worker 內部這一層(共用密鑰比對),Access 那一層需要 Theo 在 Zero Trust
// dashboard 對 `/api/batch-import/*` 這個路徑另外設一條 Bypass 政策,不然請求根本到不了
// 這裡就被 Access 攔截、導向登入頁(見 routes/batch-import.ts 開頭註解的完整說明)。

import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../bindings";

export function batchAuthMiddleware(): MiddlewareHandler<{ Bindings: Bindings }> {
  return async (c, next) => {
    const token = c.req.header("X-Local-Scanner-Token");
    if (!token || token !== c.env.LOCAL_SCANNER_TOKEN) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  };
}
