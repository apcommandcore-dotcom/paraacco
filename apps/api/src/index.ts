import { Hono } from "hono";
import { whoamiFromHeaders } from "./whoami";

// D1/R2 bindings 待 wrangler.toml 設定完成後補上型別。
type Bindings = {
  DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/api/health", (c) => c.json({ ok: true, service: "paraacco-api" }));

app.get("/api/whoami", (c) => c.json(whoamiFromHeaders(c.req.raw.headers)));

// 所有寫入(採購/資產/文件)一律經過這裡的端點,document-worker 不可直接寫 D1。
// 待補:採購/資產/文件的 CRUD 路由,稽核事件寫入。

export default app;
