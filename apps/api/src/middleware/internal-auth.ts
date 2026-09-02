// 內部服務驗證 middleware —— 只給 apps/document-worker 透過 Cloudflare Service Binding 呼叫
// /internal/* 端點用,不是給人類使用者用的(人類走 Cloudflare Access,見 auth.ts)。
//
// Service Binding 是 Worker-to-Worker 的直接 RPC/fetch,不會經過 Cloudflare Access(Access
// 只保護對外的 HTTPS 邊界),所以 /internal/* 一定不能掛在公開網域上,也一定要有自己的一層
// 驗證,否則等於完全不設防。這裡用最簡單的共用密鑰比對(wrangler secret put
// INTERNAL_SERVICE_TOKEN,兩邊 apps/api 與 apps/document-worker 要設成同一組值)。
//
// 系統動作(auto 關聯、pipeline 決定狀態等)在 activity_log 記錄時 actorMemberId 為 null,
// 前端顯示成「系統」,不歸因給任何人類成員。

import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../bindings";

export function internalAuthMiddleware(): MiddlewareHandler<{ Bindings: Bindings }> {
  return async (c, next) => {
    const token = c.req.header("X-Internal-Token");
    if (!token || token !== c.env.INTERNAL_SERVICE_TOKEN) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  };
}
