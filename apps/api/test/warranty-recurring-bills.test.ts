// 2026-09-26 migration 0008:保固、訂閱與定期繳費。測 warrantyRoute 的列舉驗證、新欄位寫入、
// 「已繳,排下一期」(POST /:id/advance),以及 0008 migration 本身(新 CHECK 約束有生效)。

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createDb, members, warrantySubscriptions } from "@paraacco/db";
import { warrantyRoute } from "../src/routes/warranty";
import type { Bindings } from "../src/bindings";
import { TEST_AUTH } from "./helpers";

function buildApp() {
  const app = new Hono<{ Bindings: Bindings }>();
  app.use("*", async (c, next) => {
    c.set("auth", TEST_AUTH);
    await next();
  });
  app.route("/", warrantyRoute);
  return app;
}

function post(app: Hono<{ Bindings: Bindings }>, path: string, body: unknown) {
  return app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
}

const WATER = {
  name: "臺北自來水 水費",
  type: "recurring_bill",
  category: "water",
  vendorName: "臺北自來水事業處",
  ownership: "per",
  endDate: "2026-10-28",
  renewalCycle: "bimonthly",
  amountCents: 69600,
  paymentMethod: "auto_debit",
  accountRef: "L-13-024736-1",
  reminderDaysBefore: 7,
};

describe("warranty 定期繳費", () => {
  beforeAll(async () => {
    const db = createDb(env.DB);
    await db.insert(members).values({
      id: TEST_AUTH.memberId!,
      email: TEST_AUTH.email!,
      name: TEST_AUTH.name!,
      role: TEST_AUTH.role!,
      scope: TEST_AUTH.scope!,
    });
  });

  // 2026-09-29(CODE_TASK_recurring-bills-single-page_20260929_V1.01.md):定期繳費搬到 /recurring,這裡不再接受
  // 新的 recurring_bill;既有列保留唯讀。原本「新增 recurring_bill」的測試改成驗證拒絕與唯讀。
  it("不再接受新的 recurring_bill(改到 /recurring)", async () => {
    const app = buildApp();
    const res = await post(app, "/", WATER);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("recurring_bill_moved");
  });

  it("既有 recurring_bill 列唯讀不刪,GET 預設不列", async () => {
    await env.DB.prepare(
      "INSERT INTO warranty_subscriptions(id, ownership, name, type, end_date, renewal_cycle) VALUES ('WSU-LEGACY-1','per','舊水費','recurring_bill','2026-10-28','bimonthly')",
    ).run();
    const app = buildApp();
    expect((await post(app, "/WSU-LEGACY-1", { name: "改名" })).status).toBe(409);
    expect((await post(app, "/WSU-LEGACY-1/advance", {})).status).toBe(409);
    expect((await post(app, "/WSU-LEGACY-1/delete", {})).status).toBe(409);
    const list = (await (await app.request("/", {}, env)).json()) as { items: Array<{ id: string }> };
    expect(list.items.some((i) => i.id === "WSU-LEGACY-1")).toBe(false);
    const legacy = (await (await app.request("/?includeLegacyRecurring=1", {}, env)).json()) as { items: Array<{ id: string }> };
    expect(legacy.items.some((i) => i.id === "WSU-LEGACY-1")).toBe(true);
    const [row] = await createDb(env.DB).select().from(warrantySubscriptions).where(eq(warrantySubscriptions.id, "WSU-LEGACY-1"));
    expect(row.name).toBe("舊水費");
  });

  const SUB = {
    name: "Adobe CC",
    type: "subscription",
    category: "software",
    vendorName: "Adobe",
    ownership: "corp",
    endDate: "2026-10-28",
    renewalCycle: "monthly",
    amountCents: 69600,
    paymentMethod: "credit_card",
    reminderDaysBefore: 7,
  };

  it("列舉不合法回 400,不打到 D1 CHECK 變 500", async () => {
    const app = buildApp();
    for (const [field, bad] of [
      ["type", { ...SUB, type: "bill" }],
      ["category", { ...SUB, category: "coffee" }],
      ["renewalCycle", { ...SUB, renewalCycle: "weekly" }],
      ["paymentMethod", { ...SUB, paymentMethod: "cash" }],
      ["amountCents", { ...SUB, amountCents: 696.5 }],
      ["endDate", { ...SUB, endDate: "2026/10/28" }],
    ] as const) {
      const res = await post(app, "/", bad);
      expect(res.status, field).toBe(400);
      expect(((await res.json()) as { field: string }).field).toBe(field);
    }
  });

  it("訂閱已繳 → 到期日推一期,可同時更新本期金額;一次性回 409", async () => {
    const app = buildApp();
    const { id } = (await (await post(app, "/", SUB)).json()) as { id: string };
    const res = await post(app, `/${id}/advance`, { amountCents: 71200 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ previousEndDate: "2026-10-28", endDate: "2026-11-28" });
    const [row] = await createDb(env.DB).select().from(warrantySubscriptions).where(eq(warrantySubscriptions.id, id));
    expect(row.endDate).toBe("2026-11-28");
    expect(row.amountCents).toBe(71200);

    const { id: oneTime } = (await (await post(app, "/", { ...SUB, type: "warranty", category: "device", renewalCycle: "one_time" })).json()) as {
      id: string;
    };
    expect((await post(app, `/${oneTime}/advance`, {})).status).toBe(409);
  });

  it("既有 warranty/subscription 仍可新增(舊呼叫端不帶新欄位)", async () => {
    const app = buildApp();
    const res = await post(app, "/", { name: "Claude Pro", type: "subscription", ownership: "corp", endDate: "2026-10-04", renewalCycle: "monthly" });
    expect(res.status).toBe(201);
  });

  it("migration 0008 的 CHECK 約束有生效(繞過 API 直接寫 D1)", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO warranty_subscriptions(id, ownership, name, type, end_date, payment_method) VALUES ('X1','per','x','recurring_bill','2026-01-01','cash')",
      ).run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("INSERT INTO warranty_subscriptions(id, ownership, name, type, end_date) VALUES ('X2','per','x','bill','2026-01-01')").run(),
    ).rejects.toThrow();
  });
});
