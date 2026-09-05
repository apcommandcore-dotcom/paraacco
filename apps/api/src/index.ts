import { Hono } from "hono";
import { cors } from "hono/cors";
import { whoamiFromHeaders } from "./whoami";
import { authMiddleware } from "./middleware/auth";
import { internalAuthMiddleware } from "./middleware/internal-auth";
import type { Bindings } from "./bindings";
import { vendorsRoute } from "./routes/vendors";
import { purchasesRoute } from "./routes/purchases";
import { assetsRoute } from "./routes/assets";
import { documentsRoute } from "./routes/documents";
import { uploadsRoute } from "./routes/uploads";
import { transfersRoute } from "./routes/transfers";
import { membersRoute } from "./routes/members";
import { activityRoute } from "./routes/activity";
import { searchRoute } from "./routes/search";
import { internalRoute } from "./routes/internal";

const app = new Hono<{ Bindings: Bindings }>();

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
app.route("/api/purchases", purchasesRoute);
app.route("/api/assets", assetsRoute);
app.route("/api/documents", documentsRoute);
app.route("/api/uploads", uploadsRoute);
app.route("/api/transfers", transfersRoute);
app.route("/api/members", membersRoute);
app.route("/api/activity", activityRoute);
app.route("/api/search", searchRoute);

// apps/document-worker 透過 Cloudflare Service Binding 呼叫,走共用密鑰驗證,不是 Access
// (見 middleware/internal-auth.ts)。這個前綴不可以掛公開網域。
app.use("/internal/*", internalAuthMiddleware());
app.route("/internal", internalRoute);

export default app;
