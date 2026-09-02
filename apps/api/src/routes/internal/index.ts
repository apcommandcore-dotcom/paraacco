// /internal/* 掛載點 —— 見 routes/internal/documents.ts、jobs.ts 開頭說明。
// internalAuthMiddleware 在 apps/api/src/index.ts 掛在整個 /internal/* 前綴上,這裡只負責
// 組裝子路由,不重複掛驗證。

import { Hono } from "hono";
import type { Bindings } from "../../bindings";
import { internalDocumentsRoute } from "./documents";
import { internalJobsRoute } from "./jobs";

export const internalRoute = new Hono<{ Bindings: Bindings }>();

internalRoute.route("/documents", internalDocumentsRoute);
internalRoute.route("/jobs", internalJobsRoute);
