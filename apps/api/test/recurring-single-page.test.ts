// 2026-09-29 CODE_TASK_recurring-bills-single-page_20260929_V1.01.md 第四節:
//   - 定期繳費項目新增/編輯(原 /warranty 欄位 + series 起訖月份、match_rule);
//   - 「已繳」推下一期,月底日期對齊和原 /advance 一致;
//   - 項目的帳單文件清單;
//   - needs_document=0(勞退)沒有文件的月份不算缺;
//   - 文件列表帶 recurringSeriesId(前端預設隱藏定期繳費帳單);
//   - 每日排程提醒即將繳費(每一期一次)。

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { createDb, documentExtractedFields, documents, members, notifications, recurringPeriods, recurringSeries, vendors } from "@paraacco/db";
import { recurringRoute } from "../src/routes/recurring";
import { documentsRoute } from "../src/routes/documents";
import { runRecurringPeriodSweep } from "../src/scheduled";
import type { Bindings } from "../src/bindings";
import { TEST_AUTH } from "./helpers";

const AUTH = { ...TEST_AUTH, scope: "personal_corp" };
const app = new Hono<{ Bindings: Bindings }>();
app.use("*", async (c, next) => {
  c.set("auth", AUTH);
  await next();
});
app.route("/recurring", recurringRoute);
app.route("/documents", documentsRoute);
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
const get = async <T>(path: string) => (await (await app.request(path, {}, env)).json()) as T;

const WATER = {
  name: "臺北自來水 水費",
  category: "water",
  ownership: "per",
  vendorId: "vendor-taipei-water",
  accountRef: "L-13-024736-1",
  cadence: "bimonthly_even",
  startMonth: "2026-02",
  matchRule: { vendorTaxId: "03774909", accountRef: "L-13-024736-1" },
  amountCents: 69600,
  paymentMethod: "auto_debit",
  nextDueDate: "2026-12-31",
  remindDays: 7,
};

describe("定期繳費單一頁 /recurring", () => {
  beforeAll(async () => {
    const db = createDb(env.DB);
    await db.insert(members).values({ id: AUTH.memberId!, email: AUTH.email!, name: AUTH.name!, role: AUTH.role!, scope: AUTH.scope! });
    await db.insert(vendors).values({ id: "vendor-taipei-water", name: "臺北自來水事業處", taxId: "03774909", defaultOwnership: "per" });
  });

  it("新增項目:欄位驗證、id 流水號、清單帶主檔供應商名稱與繳費狀態", async () => {
    for (const [field, bad] of [
      ["name", { ...WATER, name: " " }],
      ["cadence", { ...WATER, cadence: "weekly" }],
      ["startMonth", { ...WATER, startMonth: "2026/02" }],
      ["category", { ...WATER, category: "coffee" }],
      ["paymentMethod", { ...WATER, paymentMethod: "cash" }],
      ["amountCents", { ...WATER, amountCents: 1.5 }],
      ["nextDueDate", { ...WATER, nextDueDate: "2026/12/31" }],
      ["vendorId", { ...WATER, vendorId: "vnd-nope" }],
      ["endMonth", { ...WATER, endMonth: "2025-01" }],
      ["matchRule", { ...WATER, matchRule: "not json" }],
    ] as const) {
      const res = await post("/recurring/series", bad);
      expect(res.status, field).toBe(400);
      expect(((await res.json()) as { field: string }).field).toBe(field);
    }
    const res = await post("/recurring/series", WATER);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { id: string }).id).toBe("RCS-001");
    expect(((await (await post("/recurring/series", { ...WATER, name: "第二個" })).json()) as { id: string }).id).toBe("RCS-002");

    const { series } = await get<{ series: Array<Record<string, unknown>> }>("/recurring/series");
    expect(series.find((s) => s.id === "RCS-001")).toMatchObject({
      vendorName: "臺北自來水事業處",
      category: "water",
      amountCents: 69600,
      paymentMethod: "auto_debit",
      remindDays: 7,
      needsDocument: true,
      matchRule: JSON.stringify(WATER.matchRule),
    });
    // V1.04:新增項目後立即產生期次,下期繳費日改由「最早一筆未付期次的期限」算,不再用手填的值。
    expect(series.find((s) => s.id === "RCS-001")?.periodCount).toBeGreaterThan(0);
  });

  it("編輯項目:只改有給的欄位", async () => {
    expect((await post("/recurring/series/RCS-002", { endMonth: "2026-08", note: "已停用" })).status).toBe(200);
    const [row] = await createDb(env.DB).select().from(recurringSeries).where(eq(recurringSeries.id, "RCS-002"));
    expect(row).toMatchObject({ endMonth: "2026-08", note: "已停用", name: "第二個", category: "water" });
    expect((await post("/recurring/series/RCS-NOPE", { note: "x" })).status).toBe(404);
  });

  // V1.04 3.3:「已繳」不再推日期,改成把目前未付的那一期標成手動已繳(paid_source='manual')。
  it("已繳 → 最早一期未付的期次標手動已繳", async () => {
    const res = await post("/recurring/series/RCS-001/advance", {});
    expect(res.status).toBe(200);
    const { periodKey } = (await res.json()) as { periodKey: string };
    const [p] = await createDb(env.DB).select().from(recurringPeriods).where(and(eq(recurringPeriods.seriesId, "RCS-001"), eq(recurringPeriods.periodKey, periodKey)));
    expect(p).toMatchObject({ status: "paid", paidSource: "manual" });
  });

  it("項目的帳單文件清單 + 文件列表帶 recurringSeriesId", async () => {
    const db = createDb(env.DB);
    await db.insert(documents).values([
      { id: "DOC-2026-100001", ownership: "per", source: "api_import", status: "review", amountCents: 69600, invoiceDate: "2026-04-20" },
      { id: "DOC-2026-100002", ownership: "per", source: "api_import", status: "review", amountCents: 12300 },
    ]);
    await db.insert(documentExtractedFields).values([
      { documentId: "DOC-2026-100001", fieldKey: "recurring_series_id", label: "定期帳單", value: "RCS-001", extractionSource: "user_input" },
      { documentId: "DOC-2026-100001", fieldKey: "billing_month", label: "帳單月份", value: "2026-04", extractionSource: "user_input" },
    ]);
    const { documents: docs } = await get<{ documents: Array<{ id: string; billingMonths: string[]; amountCents: number }> }>(
      "/recurring/series/RCS-001/documents",
    );
    expect(docs).toEqual([expect.objectContaining({ id: "DOC-2026-100001", billingMonths: ["2026-04"], amountCents: 69600 })]);

    const list = await get<{ documents: Array<{ id: string; recurringSeriesId: string | null }> }>("/documents");
    expect(list.documents.find((d) => d.id === "DOC-2026-100001")?.recurringSeriesId).toBe("RCS-001");
    expect(list.documents.find((d) => d.id === "DOC-2026-100002")?.recurringSeriesId).toBeNull();
  });

  it("needs_document=0(勞退)沒有文件的月份不算缺;改回 1 就算缺", async () => {
    await post("/recurring/series", { name: "勞工退休金", category: "pension", cadence: "monthly", startMonth: "2026-01", needsDocument: false });
    type Cov = { series: Array<{ id: string; summary: { missing: number; notRequired: number; expected: number }; dueStatus: string }> };
    const cov = await get<Cov>("/recurring/coverage?from=2026-01&to=2026-03");
    const pension = cov.series.find((s) => s.id === "RCS-003")!;
    expect(pension.summary).toMatchObject({ expected: 3, missing: 0, notRequired: 3 });
    expect(pension.dueStatus).toBe("unscheduled");
    await post("/recurring/series/RCS-003", { needsDocument: true });
    const cov2 = await get<Cov>("/recurring/coverage?from=2026-01&to=2026-03");
    expect(cov2.series.find((s) => s.id === "RCS-003")!.summary.missing).toBe(3);
  });

  // V1.04 第四節:通知只推逾期未繳/帳單未到/缺繳款證明/待覆核掛期;每一期每種狀態一次。
  it("每日排程:帳單未到提醒,每一期一次", async () => {
    const db = createDb(env.DB);
    const now = new Date("2026-10-01T04:00:00Z");
    await runRecurringPeriodSweep(db, now);
    await runRecurringPeriodSweep(db, now);
    const rows = await db.select().from(notifications).where(eq(notifications.entityType, "recurring_period"));
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.entityId)).size).toBe(rows.length);
    expect(rows.every((r) => /帳單未到|逾期未繳|缺繳款證明/.test(r.title))).toBe(true);
  });
});
