// 測試用的最小 Hono 包裝 —— 直接掛 documentsRoute,不經過正式的 authMiddleware(那個需要
// 驗證真的 Cloudflare Access JWT,測試環境沒有辦法簽發一個真的、Cloudflare 私鑰簽過的
// token)。改成用一個假的 middleware 直接 c.set("auth", ...),模擬「已登入的公司會計」
// 身分——測的是 documentsRoute 本身的業務邏輯(狀態轉換、欄位寫入),不是重複測
// Access JWT 驗證那件事(那個已經在 access-jwt.ts 自己的邏輯裡,不需要每次都經過真的
// Access 邊界才能測業務邏輯)。

import { Hono } from "hono";
import type { AuthContext } from "../src/middleware/auth";
import { documentsRoute } from "../src/routes/documents";
import type { Bindings } from "../src/bindings";

export const TEST_AUTH: AuthContext = {
  email: "test-accountant@example.com",
  memberId: "test-member-1",
  name: "Test Accountant",
  role: "accountant",
  scope: "corp",
};

export function buildTestApp(auth: AuthContext = TEST_AUTH) {
  const app = new Hono<{ Bindings: Bindings }>();
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });
  app.route("/", documentsRoute);
  return app;
}
