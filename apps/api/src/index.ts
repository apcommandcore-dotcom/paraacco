import { Hono } from "hono";
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
