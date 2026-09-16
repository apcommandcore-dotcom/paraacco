import { Hono } from "hono";
import { cors } from "hono/cors";
import { whoamiFromHeaders } from "./whoami";
import { authMiddleware } from "./middleware/auth";
import { internalAuthMiddleware } from "./middleware/internal-auth";
import { batchAuthMiddleware } from "./middleware/batch-auth";
import type { Bindings } from "./bindings";
import { vendorsRoute } from "./routes/vendors";
import { categoriesRoute } from "./routes/categories";
import { purchasesRoute } from "./routes/purchases";
import { assetsRoute } from "./routes/assets";
import { documentsRoute } from "./routes/documents";
import { uploadsRoute } from "./routes/uploads";
import { transfersRoute } from "./routes/transfers";
import { membersRoute } from "./routes/members";
import { activityRoute } from "./routes/activity";
import { searchRoute } from "./routes/search";
import { countsRoute } from "./routes/counts";
import { warrantyRoute } from "./routes/warranty";
import { notificationsRoute } from "./routes/notifications";
import { entitiesRoute } from "./routes/entities";
import { projectsRoute } from "./routes/projects";
import { statementLinesRoute } from "./routes/statement-lines";
import { caseLinksRoute } from "./routes/case-links";
import { internalRoute } from "./routes/internal";
import { batchImportRoute } from "./routes/batch-import";
import { createDb } from "@paraacco/db";
import { handleScheduled } from "./scheduled";

const app = new Hono<{ Bindings: Bindings }>();

// 2026-09-08 補上(查 DOC-2026-000009 真實處理失敗時發現的缺口,見
// CODE_TASK_fix-panel-and-editable_20260908.md 任務 2):Hono 沒有自訂 onError 時,未捕捉
// 例外一律回傳固定文字「Internal Server Error」,真正的錯誤訊息/stack 完全遺失,
// document_processing_jobs.error_message 只存得到這串沒有資訊量的固定文字,`wrangler tail`
// 也看不到——這次查 DOC-2026-000009 的失敗原因卡在這裡,只知道「/internal/documents/:id/
// fields 丟了例外」,不知道丟了什麼。補上 onError 把真正的例外用 console.error 印出來
// (`wrangler tail` 看得到),body 也回傳更多資訊(不是只有「Internal Server Error」),
// 之後同類問題可以直接查到根因,不用再靠事後逆向工程猜測。
app.onError((err, c) => {
  console.error(`[unhandled error] ${c.req.method} ${c.req.path}:`, err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

// CORS —— apps/web 目前還沒決定部署網域(見 apps/web/app/page.tsx 開頭註解),暫時允許
// 本機開發網址與規劃中的正式網域直接跨網域呼叫 /api/*(credentials: true,讓 Cloudflare
// Access 的 session cookie 能跟著帶過去;/internal/* 不開 CORS,那個前綴不是給瀏覽器叫的)。
// 之後 web/api 都定案掛到 *.parallelserver.org 底下、走同網域時,這層可以拿掉或收斂清單。
const ALLOWED_WEB_ORIGINS = [
  "http://localhost:3000",
  "https://acco.parallelserver.org",
  "https://acco-api.parallelserver.org",
];
app.use(
  "/api/*",
  cors({
    origin: (origin) => (ALLOWED_WEB_ORIGINS.includes(origin) ? origin : ALLOWED_WEB_ORIGINS[0]),
    credentials: true,
  }),
);

// health 刻意排在 authMiddleware 之前註冊,完全不用經過 JWT 驗證(健康檢查本來就該公開、
// 該快,不該依賴 Access JWKS 這個外部相依)。whoami 也排在前面——它自己直接呼叫
// whoamiFromHeaders() 算出身分,不需要 authMiddleware 幫它另外驗證一次(避免同一個
// JWT 被驗證兩次)。
app.get("/api/health", (c) => c.json({ ok: true, service: "paraacco-api" }));
app.get("/api/whoami", async (c) => c.json(await whoamiFromHeaders(c.req.raw.headers)));

// 掛在這之後,其餘所有 /api/* 都會附上 c.get("auth")(email/memberId/role/scope)——
// email 來自驗證過簽章的 Cloudflare Access JWT(見 access-jwt.ts),不是直接信任
// client 可能偽造的 header。
app.use("/api/*", authMiddleware());

// 所有寫入(採購/資產/文件)一律經過這裡的端點,document-worker 不可直接寫 D1。
app.route("/api/vendors", vendorsRoute);
app.route("/api/categories", categoriesRoute);
app.route("/api/purchases", purchasesRoute);
app.route("/api/assets", assetsRoute);
app.route("/api/documents", documentsRoute);
app.route("/api/uploads", uploadsRoute);
app.route("/api/transfers", transfersRoute);
app.route("/api/members", membersRoute);
app.route("/api/activity", activityRoute);
app.route("/api/search", searchRoute);
app.route("/api/counts", countsRoute);
app.route("/api/warranty", warrantyRoute);
app.route("/api/notifications", notificationsRoute);
app.route("/api/entities", entitiesRoute);
app.route("/api/projects", projectsRoute);
app.route("/api/statement-lines", statementLinesRoute);
app.route("/api/case-links", caseLinksRoute);

// 每日批次進件(排程腳本呼叫,不是人類使用者也不是 document-worker)—— 共用密鑰驗證,
// 見 middleware/batch-auth.ts、routes/batch-import.ts 開頭註解(含 Cloudflare Access
// Bypass 政策的設定說明)。
app.use("/api/batch-import/*", batchAuthMiddleware());
app.route("/api/batch-import", batchImportRoute);

// apps/document-worker 透過 Cloudflare Service Binding 呼叫,走共用密鑰驗證,不是 Access
// (見 middleware/internal-auth.ts)。這個前綴不可以掛公開網域。
app.use("/internal/*", internalAuthMiddleware());
app.route("/internal", internalRoute);

// 排程通知(2026-09-07 補完設計落差任務書任務 5)—— Hono 的 app.fetch 處理一般請求,
// scheduled 是 Cloudflare Cron Trigger 額外呼叫的入口,兩者是同一個 Worker 的不同事件
// handler,見 wrangler.toml 的 [triggers] crons 設定跟 src/scheduled.ts 的邏輯本身。
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings) {
    const db = createDb(env.DB);
    await handleScheduled(event.cron, db);
  },
};
