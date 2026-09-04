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
import { transfersRoute } from "./routes/transfers";
import { membersRoute } from "./routes/members";
import { activityRoute } from "./routes/activity";
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

// 掛在最前面,所有 /api/* 都會附上 c.get("auth")(email/memberId/role/scope)。
// health、whoami 本身不需要驗證身分,但掛著無妨。
app.use("/api/*", authMiddleware());

app.get("/api/health", (c) => c.json({ ok: true, service: "paraacco-api" }));
app.get("/api/whoami", (c) => c.json(whoamiFromHeaders(c.req.raw.headers)));

// 所有寫入(採購/資產/文件)一律經過這裡的端點,document-worker 不可直接寫 D1。
app.route("/api/vendors", vendorsRoute);
app.route("/api/purchases", purchasesRoute);
app.route("/api/assets", assetsRoute);
app.route("/api/documents", documentsRoute);
app.route("/api/transfers", transfersRoute);
app.route("/api/members", membersRoute);
app.route("/api/activity", activityRoute);

// apps/document-worker 透過 Cloudflare Service Binding 呼叫,走共用密鑰驗證,不是 Access
// (見 middleware/internal-auth.ts)。這個前綴不可以掛公開網域。
app.use("/internal/*", internalAuthMiddleware());
app.route("/internal", internalRoute);

export default app;
