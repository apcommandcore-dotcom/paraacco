// 系統設定(2026-09-29,CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md 5.3)——目前只有
// mixed_ownership_cutoff:混合歸屬警告的截止日(預設 2026-10-01),開立日在這天(含)之後的發票被設成混合歸屬時,
// 覆核頁警告「專案/公司使用應單獨開發票」並列入月報表「待確認」。
//   GET  /api/settings          { settings: { mixed_ownership_cutoff: "2026-10-01" } }(沒設過回預設值)
//   POST /api/settings/:key     { value }

import { Hono } from "hono";
import { appSettings, activityLog, createDb } from "@paraacco/db";
import { DEFAULT_MIXED_OWNERSHIP_CUTOFF, MIXED_OWNERSHIP_CUTOFF_KEY } from "@paraacco/domain";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";

export const settingsRoute = new Hono<{ Bindings: Bindings }>();

const SETTINGS: Record<string, { default: string; validate: (v: string) => boolean; label: string }> = {
  [MIXED_OWNERSHIP_CUTOFF_KEY]: {
    default: DEFAULT_MIXED_OWNERSHIP_CUTOFF,
    validate: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)),
    label: "混合歸屬警告截止日",
  },
};

settingsRoute.get("/", async (c) => {
  const rows = await createDb(c.env.DB).select().from(appSettings);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const settings = Object.fromEntries(Object.entries(SETTINGS).map(([k, def]) => [k, byKey.get(k)?.value ?? def.default]));
  return c.json({ settings, updatedAt: Object.fromEntries(rows.map((r) => [r.key, r.updatedAt])) });
});

settingsRoute.post("/:key", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const key = c.req.param("key");
  const def = SETTINGS[key];
  if (!def) return c.json({ error: "unknown_setting" }, 404);
  const body = await c.req.json<{ value?: unknown }>().catch(() => null);
  const value = typeof body?.value === "string" ? body.value.trim() : "";
  if (!def.validate(value)) return c.json({ error: "invalid_value" }, 400);
  const db = createDb(c.env.DB);
  const now = new Date().toISOString();
  await db.batch([
    db
      .insert(appSettings)
      .values({ key, value, updatedByMemberId: auth.memberId, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedByMemberId: auth.memberId, updatedAt: now } }),
    db.insert(activityLog).values({
      entityType: "setting",
      entityId: key,
      kind: "review",
      text: `${auth.name ?? auth.email ?? "系統"} 修改系統設定「${def.label}」為 ${value}`,
      actorMemberId: auth.memberId,
    }),
  ]);
  return c.json({ ok: true, key, value });
});
