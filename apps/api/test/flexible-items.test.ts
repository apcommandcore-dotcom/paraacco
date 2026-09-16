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

  it("同一個 linkDocumentId 建立兩筆採購案,兩筆都各自連回同一份文件,不會互相覆蓋", async () => {
    const docId = await seedDocument();
    const app = buildApp(purchasesRoute);

    const res1 = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownership: "corp",
          purchaseDate: "2026-09-16",
          vendorNameRaw: "測試商店",
          summary: "品項 A",
          amountCents: 10000,
          linkDocumentId: docId,
        }),
      },
      env,
    );
    expect(res1.status).toBe(201);
    const { id: purchaseId1 } = (await res1.json()) as { id: string };

    const res2 = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownership: "corp",
          purchaseDate: "2026-09-16",
          vendorNameRaw: "測試商店",
          summary: "品項 B",
          amountCents: 20000,
          linkDocumentId: docId,
        }),
      },
      env,
    );
    expect(res2.status).toBe(201);
    const { id: purchaseId2 } = (await res2.json()) as { id: string };

    expect(purchaseId1).not.toBe(purchaseId2);

    const db = createDb(env.DB);
    const links = await db.select().from(documentPurchaseLinks).where(eq(documentPurchaseLinks.documentId, docId));
    const linkedPurchaseIds = links.map((l) => l.purchaseId).sort();
    expect(linkedPurchaseIds).toEqual([purchaseId1, purchaseId2].sort());

    // 詳情端點要看得到 documentLinks,兩筆各自獨立
    const detail1 = (await app.request(`/${purchaseId1}`, {}, env).then((r) => r.json())) as { documentLinks: Array<{ documentId: string }> };
    expect(detail1.documentLinks).toHaveLength(1);
    expect(detail1.documentLinks[0].documentId).toBe(docId);
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
