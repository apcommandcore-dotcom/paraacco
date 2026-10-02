// 關鍵路徑測試:「彈性標籤項目」模型(2026-09-16,見
// paraacco-flexible-item-model-design-20260916.md)——一份文件拆成多個獨立項目,各自連回
// 同一份來源文件;資產也能像採購案一樣自由貼標籤。

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb, documentPurchaseLinks, documents, members, nextId } from "@paraacco/db";
import { eq } from "drizzle-orm";
import type { AuthContext } from "../src/middleware/auth";
import { purchasesRoute } from "../src/routes/purchases";
import { assetsRoute } from "../src/routes/assets";

const TEST_AUTH: AuthContext = {
  email: "test-accountant@example.com",
  memberId: "test-member-flex",
  name: "Test Accountant",
  role: "accountant",
  scope: "corp",
};

function buildApp(route: Hono<{ Bindings: import("../src/bindings").Bindings }>) {
  const app = new Hono<{ Bindings: import("../src/bindings").Bindings }>();
  app.use("*", async (c, next) => {
    c.set("auth", TEST_AUTH);
    await next();
  });
  app.route("/", route);
  return app;
}

async function seedDocument() {
  const db = createDb(env.DB);
  const id = await nextId(db, "DOC", 2026);
  await db.insert(documents).values({ id, ownership: "corp", source: "api_import", status: "review" });
  return id;
}

describe("彈性標籤項目:一份文件拆成多個獨立採購案", () => {
  beforeAll(async () => {
    const db = createDb(env.DB);
    await db.insert(members).values({ id: TEST_AUTH.memberId!, email: TEST_AUTH.email!, name: TEST_AUTH.name!, role: TEST_AUTH.role!, scope: TEST_AUTH.scope! });
  });

  // 2026-09-29(CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md):物件 = 一筆消費,一份文件最多屬於一個物件,
  // 原本「同一份文件拆成兩筆採購案」改成在物件裡拆品項——第二次用同一個 linkDocumentId 建採購案回 409,指到既有物件。
  it("同一個 linkDocumentId 第二次建立採購案回 409(改在物件裡新增品項)", async () => {
    const docId = await seedDocument();
    const app = buildApp(purchasesRoute);
    const make = (summary: string, amountCents: number) =>
      app.request(
        "/",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ownership: "corp", purchaseDate: "2026-09-16", vendorNameRaw: "測試商店", summary, amountCents, linkDocumentId: docId }),
        },
        env,
      );

    const res1 = await make("品項 A", 10000);
    expect(res1.status).toBe(201);
    const { id: purchaseId1 } = (await res1.json()) as { id: string };

    const res2 = await make("品項 B", 20000);
    expect(res2.status).toBe(409);
    expect(await res2.json()).toMatchObject({ error: "already_in_object", purchaseId: purchaseId1 });

    const itemRes = await app.request(
      `/${purchaseId1}/items`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "品項 B", amountCents: 20000 }) },
      env,
    );
    expect(itemRes.status).toBe(201);

    const db = createDb(env.DB);
    const links = await db.select().from(documentPurchaseLinks).where(eq(documentPurchaseLinks.documentId, docId));
    expect(links.map((l) => l.purchaseId)).toEqual([purchaseId1]);
    const detail1 = (await app.request(`/${purchaseId1}`, {}, env).then((r) => r.json())) as { documentLinks: Array<{ documentId: string }>; object: { items: Array<{ name: string }> } };
    expect(detail1.documentLinks).toHaveLength(1);
    expect(detail1.object.items.map((i) => i.name)).toEqual(["品項 B"]);
  });
});

describe("彈性標籤項目:資產標籤(asset_tags)", () => {
  it("建立資產時帶 tags,詳情端點能讀回來", async () => {
    const app = buildApp(assetsRoute);
    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownership: "corp", name: "測試資產", tags: ["家庭", "設備"] }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const detail = (await app.request(`/${id}`, {}, env).then((r) => r.json())) as { tags: string[] };
    expect(detail.tags.sort()).toEqual(["家庭", "設備"].sort());
  });
});
