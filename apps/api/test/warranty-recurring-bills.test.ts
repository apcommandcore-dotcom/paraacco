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

  it("新增 recurring_bill,新欄位都寫入", async () => {
    const app = buildApp();
    const res = await post(app, "/", WATER);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const [row] = await createDb(env.DB).select().from(warrantySubscriptions).where(eq(warrantySubscriptions.id, id));
    expect(row.type).toBe("recurring_bill");
    expect(row.category).toBe("water");
    expect(row.renewalCycle).toBe("bimonthly");
    expect(row.paymentMethod).toBe("auto_debit");
    expect(row.accountRef).toBe("L-13-024736-1");
    expect(row.amountCents).toBe(69600);
  });

  it("列舉不合法回 400,不打到 D1 CHECK 變 500", async () => {
    const app = buildApp();
    for (const [field, bad] of [
      ["type", { ...WATER, type: "bill" }],
      ["category", { ...WATER, category: "coffee" }],
      ["renewalCycle", { ...WATER, renewalCycle: "weekly" }],
      ["paymentMethod", { ...WATER, paymentMethod: "cash" }],
      ["amountCents", { ...WATER, amountCents: 696.5 }],
      ["endDate", { ...WATER, endDate: "2026/10/28" }],
    ] as const) {
      const res = await post(app, "/", bad);
      expect(res.status, field).toBe(400);
      expect(((await res.json()) as { field: string }).field).toBe(field);
    }
  });

  it("已繳 → 到期日推一期,可同時更新本期金額;一次性回 409", async () => {
    const app = buildApp();
    const { id } = (await (await post(app, "/", WATER)).json()) as { id: string };
    const res = await post(app, `/${id}/advance`, { amountCents: 71200 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ previousEndDate: "2026-10-28", endDate: "2026-12-28" });
    const [row] = await createDb(env.DB).select().from(warrantySubscriptions).where(eq(warrantySubscriptions.id, id));
    expect(row.endDate).toBe("2026-12-28");
    expect(row.amountCents).toBe(71200);

    const { id: oneTime } = (await (await post(app, "/", { ...WATER, type: "warranty", category: "device", renewalCycle: "one_time" })).json()) as {
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
