// 成員與角色 —— 規格 2.12、3.7-1。v2:角色收斂為「公司會計」「負責人」+ admin(見範圍決策——
// paraacco 介面的實際使用者只有這兩種角色,個人代墊項目由這兩人登錄/覆核,不是本人登入操作)。

import { Hono } from "hono";
import { createDb, members } from "@paraacco/db";
import type { Bindings } from "../bindings";

export const membersRoute = new Hono<{ Bindings: Bindings }>();

const VALID_ROLES = ["admin", "accountant", "principal"];
const VALID_SCOPES = ["personal_corp", "corp", "corp_readonly"];

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
  if (!VALID_ROLES.includes(body.role)) return c.json({ error: "invalid_role" }, 400);
  if (!VALID_SCOPES.includes(body.scope)) return c.json({ error: "invalid_scope" }, 400);

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
