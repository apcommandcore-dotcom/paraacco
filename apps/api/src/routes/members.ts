// 成員與角色 —— 規格 2.12、3.7-1。角色/範圍定義目前沿用規格文件缺口清單第 3 點的最小可行版本
// (role 自由文字 + scope 三態),完整權限矩陣待 Gemini/Perplexity 或後續會議補完。

import { Hono } from "hono";
import { createDb, members } from "@paraacco/db";
import type { Bindings } from "../bindings";

export const membersRoute = new Hono<{ Bindings: Bindings }>();

membersRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.select().from(members);
  return c.json({ members: rows });
});

// 只有 admin 角色可以新增成員。
membersRoute.post("/", async (c) => {
  const auth = c.get("auth");
  if (auth.role !== "admin") return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{ id: string; email: string; name: string; role: string; scope: string }>();
  const db = createDb(c.env.DB);
  await db.insert(members).values({
    id: body.id,
    email: body.email,
    name: body.name,
    role: body.role,
    scope: body.scope,
    status: "active",
  });

  return c.json({ ok: true, id: body.id }, 201);
});
