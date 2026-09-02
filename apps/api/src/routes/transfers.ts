// 歸屬移轉與稽核 —— 規格 2.11、3.7-5。業務規則:移轉不得直接覆寫歸屬欄位,必須走
// 申請(pending)→ 核准(approved,實際變更 purchases/assets.ownership)或駁回(rejected)。

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { activityLog, assets, createDb, nextId, purchases, transfers } from "@paraacco/db";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";

export const transfersRoute = new Hono<{ Bindings: Bindings }>();

transfersRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.select().from(transfers);
  return c.json({ transfers: rows });
});

transfersRoute.post("/", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope) || !auth.memberId) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{
    targetType: "purchase" | "asset";
    targetId: string;
    fromOwnership: string;
    toOwnership: string;
    reason: string;
  }>();

  const db = createDb(c.env.DB);
  const id = await nextId(db, "TRF", new Date().getFullYear());

  await db.insert(transfers).values({
    id,
    targetType: body.targetType,
    targetId: body.targetId,
    fromOwnership: body.fromOwnership,
    toOwnership: body.toOwnership,
    reason: body.reason,
    requestedBy: auth.memberId,
    status: "pending",
  });

  await db.insert(activityLog).values({
    entityType: body.targetType,
    entityId: body.targetId,
    kind: "transfer",
    text: `${auth.name ?? auth.email} 申請歸屬移轉:${body.fromOwnership} → ${body.toOwnership}(${body.reason})`,
    actorMemberId: auth.memberId,
  });

  return c.json({ ok: true, id }, 201);
});

// 核准/駁回 —— 只有 personal_corp 範圍(對應設計稿裡「管理者」/公司負責人角色)可以決行。
transfersRoute.post("/:id/decide", async (c) => {
  const auth = c.get("auth");
  if (auth.scope !== "personal_corp") return c.json({ error: "forbidden" }, 403);

  const id = c.req.param("id");
  const body = await c.req.json<{ approve: boolean }>();
  const db = createDb(c.env.DB);

  const [t] = await db.select().from(transfers).where(eq(transfers.id, id)).limit(1);
  if (!t) return c.json({ error: "not_found" }, 404);
  if (t.status !== "pending") return c.json({ error: "already_decided" }, 409);

  await db
    .update(transfers)
    .set({
      status: body.approve ? "approved" : "rejected",
      approvedBy: auth.memberId,
      decidedAt: new Date().toISOString(),
    })
    .where(eq(transfers.id, id));

  if (body.approve) {
    if (t.targetType === "purchase") {
      await db
        .update(purchases)
        .set({ ownership: t.toOwnership, updatedAt: new Date().toISOString() })
        .where(eq(purchases.id, t.targetId));
    } else {
      await db
        .update(assets)
        .set({ ownership: t.toOwnership, updatedAt: new Date().toISOString() })
        .where(eq(assets.id, t.targetId));
    }
  }

  await db.insert(activityLog).values({
    entityType: t.targetType,
    entityId: t.targetId,
    kind: "transfer",
    text: `${auth.name ?? auth.email} ${body.approve ? "核准" : "駁回"}歸屬移轉申請 ${id}`,
    actorMemberId: auth.memberId,
  });

  return c.json({ ok: true });
});
