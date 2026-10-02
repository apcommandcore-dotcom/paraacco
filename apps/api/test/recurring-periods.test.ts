// 2026-10-01 CODE_TASK_recurring-bills-single-page_20260929_V1.04.md 第八節(API 層):
//   新增項目後不做任何操作:既有帳單自動掛到期次、對帳單扣款自動標已繳;require_proof 只有扣款 → debited,掛證明才 paid;
//   同一期重複帳單不覆蓋、進待覆核;中信心進待覆核、一鍵確認;統編未建檔不自動掛;拆掉錯掛文件 → 回到一般列表;
//   月份檢核格子帶期次狀態。

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { activityLog, createDb, documentExtractedFields, documentFiles, documents, members, recurringMatchReviews, recurringPeriods, vendors } from "@paraacco/db";
import { recurringRoute } from "../src/routes/recurring";
import { internalStatementLinesRoute } from "../src/routes/internal/statement-lines";
import { matchRecurringDocument } from "../src/recurring-matching";
import type { Bindings } from "../src/bindings";
import { TEST_AUTH } from "./helpers";

const AUTH = { ...TEST_AUTH, scope: "personal_corp" };
const app = new Hono<{ Bindings: Bindings }>();
app.use("*", async (c, next) => {
  c.set("auth", AUTH);
  await next();
});
app.route("/recurring", recurringRoute);
app.route("/internal/statement-lines", internalStatementLinesRoute);
const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
const get = async <T>(path: string) => (await (await app.request(path, {}, env)).json()) as T;

async function seedDoc(id: string, o: Partial<typeof documents.$inferInsert>, fields: Record<string, string>, fileType = "帳單") {
  const db = createDb(env.DB);
  await db.insert(documents).values({ id, ownership: "per", source: "api_import", status: "review", ...o });
  await db.insert(documentFiles).values({
    documentId: id,
    kind: "original",
    r2Key: `local:${id}`,
    originalFileName: `${id}.pdf`,
    mimeType: "application/pdf",
    byteSize: 1,
    storage: "local",
    localPath: `Paraacco_公司財務系統/30_家庭個人/2026/02_帳單繳費/20260828_${fileType}_x_1_${id}.pdf`,
  });
  for (const [k, v] of Object.entries(fields)) {
    await db.insert(documentExtractedFields).values({ documentId: id, fieldKey: k, label: k, value: v, extractionSource: "ai_inference", sourceNote: "外部擷取:test" });
  }
}
async function period(seriesId: string, key: string) {
  const [p] = await createDb(env.DB).select().from(recurringPeriods).where(and(eq(recurringPeriods.seriesId, seriesId), eq(recurringPeriods.periodKey, key)));
  return p;
}

describe("定期繳費:項目只建一次,每期自動掛入", () => {
  beforeAll(async () => {
    const db = createDb(env.DB);
    await db.insert(members).values({ id: AUTH.memberId!, email: AUTH.email!, name: AUTH.name!, role: AUTH.role!, scope: AUTH.scope! });
    await db.insert(vendors).values({ id: "vendor-taipei-water", name: "臺北自來水事業處", taxId: "03774909", defaultOwnership: "per" });
    await db.insert(documents).values({ id: "DOC-STMT", ownership: "per", source: "api_import", status: "review" });
    await env.DB.prepare("INSERT INTO entities (id, name) VALUES ('ap', '平行空間有限公司')").run();
    // 既有帳單:2026-08 期末(115年07-08月),統編 + 水號都對得上
    await seedDoc("DOC-2026-300001", { amountCents: 69600, invoiceDate: "2026-08-28", vendorId: "vendor-taipei-water" }, { vendorTaxId: "03774909", accountNumber: "C108001950", billing_month: "2026-08" });
    // 同一期又來一份帳單
    await seedDoc("DOC-2026-300002", { amountCents: 69600, invoiceDate: "2026-08-29", vendorId: "vendor-taipei-water" }, { vendorTaxId: "03774909", accountNumber: "C108001950", billing_month: "2026-08" });
  });

  it("新增項目後不做任何操作:既有帳單自動出現在對應期次", async () => {
    const res = await post("/recurring/series", {
      name: "台北自來水",
      category: "water",
      cadence: "bimonthly_even",
      startMonth: "2026-01",
      ownership: "per",
      vendorId: "vendor-taipei-water",
      paymentMethod: "auto_debit",
      matchRule: { vendorTaxId: "03774909", accountRefs: ["C108001950"], statementKeywords: ["台北自來水"] },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; backfill: { attachedDocs: Array<{ documentId: string; periodKey: string }>; reviews: number[] } };
    expect(body.backfill.attachedDocs).toEqual([{ documentId: "DOC-2026-300001", periodKey: "2026-07" }]);
    expect(await period(body.id, "2026-07")).toMatchObject({ status: "billed", billDocId: "DOC-2026-300001", amountCents: 69600 });
    // 同一期第二份帳單不覆蓋,進待覆核
    const reviews = await createDb(env.DB).select().from(recurringMatchReviews).where(eq(recurringMatchReviews.documentId, "DOC-2026-300002"));
    expect(reviews[0]).toMatchObject({ reason: "duplicate_bill", status: "pending" });
  });

  it("對帳單扣款匯入後自動標已繳(對帳單)", async () => {
    const res = await post("/internal/statement-lines/documents/DOC-STMT", {
      entityId: "ap",
      lines: [{ date: "2026-09-14", amountCents: 69600, description: "台北自來水費 自動扣繳" }],
    });
    expect(res.status).toBe(200);
    expect(await period("RCS-001", "2026-07")).toMatchObject({ status: "paid", paidSource: "statement" });
  });

  it("require_proof(勞退):只有扣款 → 已扣款、缺證明;掛上繳款證明後才轉已繳", async () => {
    await post("/recurring/series", {
      name: "勞工退休金",
      category: "pension",
      cadence: "monthly",
      startMonth: "2026-08",
      paymentMethod: "auto_debit",
      amountMode: "fixed",
      amountCents: 600000,
      dueRule: "fixed_day",
      dueDay: 15,
      requireProof: true,
      matchRule: { statementKeywords: ["勞退"] },
    });
    await post("/internal/statement-lines/documents/DOC-STMT", { entityId: "ap", lines: [{ date: "2026-09-15", amountCents: 600000, description: "勞退提繳 自動扣款" }] });
    expect(await period("RCS-002", "2026-09")).toMatchObject({ status: "debited" });
    const { periods } = await get<{ periods: Array<{ id: number; periodKey: string; displayStatus: string }> }>("/recurring/series/RCS-002/periods");
    const sep = periods.find((p) => p.periodKey === "2026-09")!;
    expect(sep.displayStatus).toBe("debited");
    await seedDoc("DOC-2026-300010", { amountCents: 600000, invoiceDate: "2026-09-20" }, {}, "收據");
    const r = await post(`/recurring/periods/${sep.id}/attach`, { documentId: "DOC-2026-300010" });
    expect(r.status).toBe(200);
    expect(await period("RCS-002", "2026-09")).toMatchObject({ status: "paid", paidSource: "proof", proofDocId: "DOC-2026-300010" });
  });

  it("中信心(只對到統編)→ 待覆核,一鍵確認後掛上;統編未建檔不自動掛", async () => {
    await seedDoc("DOC-2026-300020", { amountCents: 70000, invoiceDate: "2026-10-27", vendorId: "vendor-taipei-water" }, { vendorTaxId: "03774909", billing_month: "2026-10" });
    const r = await matchRecurringDocument(createDb(env.DB), "DOC-2026-300020");
    expect(r).toMatchObject({ outcome: "review", reason: "medium_confidence" });
    const { reviews } = await get<{ reviews: Array<{ id: number; documentId: string }> }>("/recurring/reviews?documentId=DOC-2026-300020");
    expect((await post(`/recurring/reviews/${reviews[0].id}/accept`, {})).status).toBe(200);
    expect(await period("RCS-001", "2026-09")).toMatchObject({ billDocId: "DOC-2026-300020", status: "billed" });

    await seedDoc("DOC-2026-300030", { amountCents: 431000, invoiceDate: "2026-04-23" }, { vendorTaxId: "31096199", billing_month: "2026-04" });
    await post("/recurring/series", { name: "台灣電力", cadence: "bimonthly_even", startMonth: "2026-01", matchRule: { vendorTaxId: "31096199" } });
    const e = await matchRecurringDocument(createDb(env.DB), "DOC-2026-300030");
    expect(e).toMatchObject({ outcome: "review", reason: "vendor_unregistered" });
  });

  it("手動拆掉錯掛的文件:期次退回、文件回到一般列表、activity_log 有紀錄", async () => {
    const p = await period("RCS-001", "2026-09");
    const r = await post(`/recurring/periods/${p.id}/detach`, { documentId: "DOC-2026-300020" });
    expect(await r.json()).toMatchObject({ ok: true, status: "expected" });
    const fields = await createDb(env.DB).select().from(documentExtractedFields).where(and(eq(documentExtractedFields.documentId, "DOC-2026-300020"), eq(documentExtractedFields.fieldKey, "recurring_series_id")));
    expect(fields).toEqual([]);
    const logs = await createDb(env.DB).select().from(activityLog).where(eq(activityLog.entityId, "DOC-2026-300020"));
    expect(logs.some((l) => l.text.includes("拆掉"))).toBe(true);
  });

  it("月份檢核格子帶期次狀態;清單的下期繳費日由期次算", async () => {
    const cov = await get<{ series: Array<{ id: string; currentStatus: string | null; months: Array<{ month: string; periodStatus?: string }> }> }>("/recurring/coverage?from=2026-07&to=2026-08");
    const water = cov.series.find((s) => s.id === "RCS-001")!;
    expect(water.months.find((m) => m.month === "2026-08")?.periodStatus).toBe("paid");
    expect(water.currentStatus).not.toBeNull();
  });
});
