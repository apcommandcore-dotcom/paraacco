// 專案 —— 2026-09-13 財務文件自動分類新增,取代 purchases.subNote 鬆散文字(見
// packages/db/src/schema.ts projects 註解)。id 沿用既有的 AP_YYNNN 專案代碼慣例,人工指定,
// 不經 id_sequences 流水號(格式一年 2 位數 + 3 位數流水號,跟其他實體的 4 位數年份/6 位數
// 流水號慣例不一樣,不套用 nextId())。

import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { createDb, projects } from "@paraacco/db";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";

export const projectsRoute = new Hono<{ Bindings: Bindings }>();

projectsRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const status = c.req.query("status");
  const rows = status
    ? await db.select().from(projects).where(eq(projects.status, status)).orderBy(desc(projects.createdAt))
    : await db.select().from(projects).orderBy(desc(projects.createdAt));
  return c.json({ projects: rows });
});

projectsRoute.post("/", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{
    id: string; // AP_YYNNN,人工指定
    name: string;
    status?: string;
    budgetAmountCents?: number;
    startDate?: string;
    endDate?: string;
  }>();

  const db = createDb(c.env.DB);
  await db.insert(projects).values({
    id: body.id,
    name: body.name,
    status: body.status ?? "active",
    budgetAmountCents: body.budgetAmountCents ?? null,
    startDate: body.startDate ?? null,
    endDate: body.endDate ?? null,
  });

  return c.json({ ok: true, id: body.id }, 201);
});
