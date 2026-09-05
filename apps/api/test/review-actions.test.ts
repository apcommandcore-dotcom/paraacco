// 關鍵路徑測試 2/2:待覆核工作台的核准/退回操作對 documents 狀態的影響——
// POST /:id/link(核准並歸檔,連結到採購案/資產)、POST /:id/status(標示重複/略過/失敗)。
// 這條路徑壞了會直接讓帳務資料錯亂(文件該歸檔的沒歸檔、不該連結的連結錯物件),見
// CODE_TASK_post-golive-hardening_20260905.md 任務 6。

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, documentPurchaseLinks, documents, members, nextId, purchases, relationCandidates } from "@paraacco/db";
import { eq } from "drizzle-orm";
import { buildTestApp, TEST_AUTH } from "./helpers";

async function seedDocument(status = "review") {
  const db = createDb(env.DB);
  const id = await nextId(db, "DOC", 2026);
  await db.insert(documents).values({ id, ownership: "corp", source: "web_upload", status });
  return id;
}

async function seedPurchase() {
  const db = createDb(env.DB);
  const id = await nextId(db, "PUR", 2026);
  await db.insert(purchases).values({
    id,
    ownership: "corp",
    purchaseDate: "2026-09-01",
    vendorNameRaw: "測試供應商",
    summary: "測試採購案",
    amountCents: 100000,
  });
  return id;
}

describe("待覆核工作台操作 → documents 狀態", () => {
  beforeAll(async () => {
    // document_purchase_links/activity_log 等表的 created_by_member_id/actor_member_id
    // 有 FK 指到 members.id——測試用的假 auth context(見 helpers.ts 的 TEST_AUTH)只在
    // request context 裡存在,D1 裡沒有對應的 member 列,要先種一筆進去 FK 才會過。
    // 用 beforeAll 不是 beforeEach:同一個測試檔案裡的多個 it() 共用同一個 D1 實例
    // (@cloudflare/vitest-plugin 是「每個檔案」隔離,不是「每個 test」隔離),beforeEach
    // 會導致第二個 it() 開始撞 email UNIQUE constraint。
    const db = createDb(env.DB);
    await db.insert(members).values({
      id: TEST_AUTH.memberId!,
      email: TEST_AUTH.email!,
      name: TEST_AUTH.name!,
      role: TEST_AUTH.role!,
      scope: TEST_AUTH.scope!,
    });
  });

  it("POST /:id/link:核准並連結採購案後,文件狀態變成 archived", async () => {
    const app = buildTestApp();
    const docId = await seedDocument("review");
    const purchaseId = await seedPurchase();

    const res = await app.request(`/${docId}/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetType: "purchase", targetId: purchaseId }),
    }, env);
    expect(res.status).toBe(200);

    const db = createDb(env.DB);
    const [doc] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1);
    expect(doc?.status).toBe("archived");

    const links = await db.select().from(documentPurchaseLinks).where(eq(documentPurchaseLinks.documentId, docId));
    expect(links).toHaveLength(1);
    expect(links[0]?.purchaseId).toBe(purchaseId);
    expect(links[0]?.linkedBy).toBe("manual");
  });

  it("POST /:id/link:挑選候選時連動把該筆候選標成 accepted、其餘 pending 候選標成 superseded", async () => {
    const app = buildTestApp();
    const docId = await seedDocument("review");
    const purchaseA = await seedPurchase();
    const purchaseB = await seedPurchase();

    const db = createDb(env.DB);
    await db.insert(relationCandidates).values([
      { documentId: docId, targetType: "purchase", targetId: purchaseA, score: 90, rawScore: 90, reasonsJson: "[]", algorithmVersion: "v2", decision: "pending" },
      { documentId: docId, targetType: "purchase", targetId: purchaseB, score: 40, rawScore: 40, reasonsJson: "[]", algorithmVersion: "v2", decision: "pending" },
    ]);
    const candidateRows = await db.select().from(relationCandidates).where(eq(relationCandidates.documentId, docId));
    const candidateA = candidateRows.find((c) => c.targetId === purchaseA)!;

    const res = await app.request(`/${docId}/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetType: "purchase", targetId: purchaseA, candidateId: candidateA.id }),
    }, env);
    expect(res.status).toBe(200);

    const after = await db.select().from(relationCandidates).where(eq(relationCandidates.documentId, docId));
    const afterA = after.find((c) => c.targetId === purchaseA);
    const afterB = after.find((c) => c.targetId === purchaseB);
    expect(afterA?.decision).toBe("accepted");
    expect(afterB?.decision).toBe("superseded");
  });

  it("POST /:id/status:標示重複(dup)時文件狀態變成 dup,不會建立任何關聯", async () => {
    const app = buildTestApp();
    const docId = await seedDocument("review");

    const res = await app.request(`/${docId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "dup", note: "跟 DOC-2026-000001 重複" }),
    }, env);
    expect(res.status).toBe(200);

    const db = createDb(env.DB);
    const [doc] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1);
    expect(doc?.status).toBe("dup");

    const links = await db.select().from(documentPurchaseLinks).where(eq(documentPurchaseLinks.documentId, docId));
    expect(links).toHaveLength(0);
  });

  it("POST /:id/status:標示 archived 時會補上 archivedAt 時間戳", async () => {
    const app = buildTestApp();
    const docId = await seedDocument("review");

    const res = await app.request(`/${docId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    }, env);
    expect(res.status).toBe(200);

    const db = createDb(env.DB);
    const [doc] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1);
    expect(doc?.status).toBe("archived");
    expect(doc?.archivedAt).not.toBeNull();
  });

  it("寫入權限:唯讀 scope(corp_readonly)不能核准/退回,回 403 且不改動狀態", async () => {
    const readonlyAuth = { email: "readonly@example.com", memberId: "m2", name: "Readonly", role: "principal", scope: "corp_readonly" };
    const app = buildTestApp(readonlyAuth);
    const docId = await seedDocument("review");

    const res = await app.request(`/${docId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "dup" }),
    }, env);
    expect(res.status).toBe(403);

    const db = createDb(env.DB);
    const [doc] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1);
    expect(doc?.status).toBe("review");
  });
});
