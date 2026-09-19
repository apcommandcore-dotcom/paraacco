// 關鍵路徑測試:CODE_TASK_archive-backfill-ownership-hint_20260918.md——批次進件可選傳
// ownership 預標歸屬,傳了就標記 ownership_confirmed,/classify 分類階段不覆蓋;沒傳的行為不變。

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb, documents } from "@paraacco/db";
import { eq } from "drizzle-orm";
import type { Bindings } from "../src/bindings";
import { batchImportRoute } from "../src/routes/batch-import";
import { internalDocumentsRoute } from "../src/routes/internal/documents";

const app = new Hono<{ Bindings: Bindings }>();
app.route("/batch-import", batchImportRoute);
app.route("/internal/documents", internalDocumentsRoute);

async function importFile(ownership?: string) {
  const form = new FormData();
  form.set("file", new File([`fake pdf ${crypto.randomUUID()}`], "test.pdf", { type: "application/pdf" }));
  if (ownership !== undefined) form.set("ownership", ownership);
  return app.request("/batch-import/documents", { method: "POST", body: form }, env);
}

async function classify(id: string, scope: string) {
  return app.request(
    `/internal/documents/${id}/classify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountCents: 10000, scope, classificationConfidence: "high", financeDocType: "UTIL" }),
    },
    env,
  );
}

async function getDoc(id: string) {
  const db = createDb(env.DB);
  const [row] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  return row;
}

describe("批次進件 ownership 預標", () => {
  it("傳 ownership=per:登記為 per + 已確認,classify 判讀成 CORP-AP 也不會覆蓋", async () => {
    const res = await importFile("per");
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const before = await getDoc(id);
    expect(before.ownership).toBe("per");
    expect(before.ownershipConfirmed).toBe(true);

    expect((await classify(id, "CORP-AP")).status).toBe(200);
    expect((await getDoc(id)).ownership).toBe("per");
  });

  it("沒傳 ownership:維持 corp 佔位、未確認,classify 照常用判讀結果覆蓋(既有行為不變)", async () => {
    const res = await importFile();
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const before = await getDoc(id);
    expect(before.ownership).toBe("corp");
    expect(before.ownershipConfirmed).toBe(false);

    expect((await classify(id, "PERS")).status).toBe(200);
    expect((await getDoc(id)).ownership).toBe("per");
  });

  it("ownership 值不合法直接 400,不會建立文件", async () => {
    const res = await importFile("bogus");
    expect(res.status).toBe(400);
  });
});
