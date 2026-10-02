// 定期帳單月份檢核(2026-09-28,CODE_TASK_local-originals-nas-path_20260927_V1.01.md 第三節 6、
// 第六節 4–5)——人類使用者端(Cloudflare Access)。
//
//   GET  /api/recurring/series                      series 清單
//   GET  /api/recurring/coverage?from=YYYY-MM&to=YYYY-MM
//                                                   每個 series × 月份的狀態(有/缺/只有催繳/加密/無需帳單)與 DOC id
//   POST /api/recurring/series/:id/marks            人工標記某月「無需帳單」/「加密」,status=null 取消標記
//   GET  /api/recurring/documents/:id               覆核頁:這份文件目前的 billing_month/series/專案代碼 + 系統建議
//   POST /api/recurring/documents/:id               覆核頁:人工確認 billing_month/series/專案代碼
//
// 月份與文件的對應存在 document_extracted_fields(見 @paraacco/domain 的 recurring.ts),催繳判斷沿用
// document_case_links.role(reminder/penalty/enforcement),不另開欄位。

import { Hono } from "hono";
import { and, eq, inArray, like, or } from "drizzle-orm";
import {
  activityLog,
  createDb,
  documentCaseLinks,
  documentExtractedFields,
  documents,
  recurringMonthMarks,
  recurringSeries,
} from "@paraacco/db";
import {
  BILLING_MONTH_FIELD_KEY,
  MAX_BILLING_MONTHS_PER_DOCUMENT,
  RECURRING_SERIES_FIELD_KEY,
  addMonths,
  billingMonthFieldKey,
  computeCoverage,
  isBillingMonthFieldKey,
  isValidMonth,
  lastCompleteMonth,
  suggestBillingMonths,
  suggestSeries,
  type CoverageDocRef,
  type RecurringCadence,
} from "@paraacco/domain";
import type { Bindings } from "../bindings";
import { canAccessOwnership, canWrite } from "../middleware/auth";

export const recurringRoute = new Hono<{ Bindings: Bindings }>();

const REMINDER_ROLES = ["reminder", "penalty", "enforcement"];
const MARK_STATUSES = ["not_required", "encrypted"] as const;
const PROJECT_CODE_RE = /^AP_\d{5}$/;
const EXCLUDED_DOC_STATUSES = new Set(["ignored", "dup"]);

function visibleSeries<T extends { ownership: string | null }>(scope: string | null, rows: T[]): T[] {
  // ownership 為 null/pending(未分流)視為公司範圍可見;'per' 只有 personal_corp 看得到。
  return rows.filter((s) => canAccessOwnership(scope, s.ownership && s.ownership !== "pending" ? s.ownership : "corp"));
}

recurringRoute.get("/series", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.select().from(recurringSeries).orderBy(recurringSeries.id);
  return c.json({ series: visibleSeries(c.get("auth").scope, rows) });
});

recurringRoute.get("/coverage", async (c) => {
  const to = c.req.query("to") ?? lastCompleteMonth();
  const from = c.req.query("from") ?? addMonths(to, -23);
  if (!isValidMonth(from) || !isValidMonth(to) || from > to) {
    return c.json({ error: "invalid_range", message: "from/to 必須是 YYYY-MM,且 from ≤ to" }, 400);
  }

  const db = createDb(c.env.DB);
  const [seriesRows, fieldRows, reminderRows, markRows] = await Promise.all([
    db.select().from(recurringSeries).orderBy(recurringSeries.id),
    db
      .select({
        documentId: documentExtractedFields.documentId,
        fieldKey: documentExtractedFields.fieldKey,
        value: documentExtractedFields.value,
        docStatus: documents.status,
      })
      .from(documentExtractedFields)
      .innerJoin(documents, eq(documents.id, documentExtractedFields.documentId))
      .where(
        or(
          eq(documentExtractedFields.fieldKey, RECURRING_SERIES_FIELD_KEY),
          like(documentExtractedFields.fieldKey, `${BILLING_MONTH_FIELD_KEY}%`),
        ),
      ),
    db
      .selectDistinct({ documentId: documentCaseLinks.documentId })
      .from(documentCaseLinks)
      .where(inArray(documentCaseLinks.role, REMINDER_ROLES)),
    db.select().from(recurringMonthMarks),
  ]);

  const reminderDocs = new Set(reminderRows.map((r) => r.documentId));
  const seriesByDoc = new Map<string, string>();
  const monthsByDoc = new Map<string, string[]>();
  for (const f of fieldRows) {
    if (EXCLUDED_DOC_STATUSES.has(f.docStatus) || !f.value) continue;
    if (f.fieldKey === RECURRING_SERIES_FIELD_KEY) seriesByDoc.set(f.documentId, f.value);
    else if (isBillingMonthFieldKey(f.fieldKey) && isValidMonth(f.value)) {
      monthsByDoc.set(f.documentId, [...(monthsByDoc.get(f.documentId) ?? []), f.value]);
    }
  }

  const docsBySeries = new Map<string, Map<string, CoverageDocRef[]>>();
  for (const [documentId, seriesId] of seriesByDoc) {
    const byMonth = docsBySeries.get(seriesId) ?? new Map<string, CoverageDocRef[]>();
    for (const month of monthsByDoc.get(documentId) ?? []) {
      byMonth.set(month, [...(byMonth.get(month) ?? []), { documentId, isReminder: reminderDocs.has(documentId) }]);
    }
    docsBySeries.set(seriesId, byMonth);
  }

  const series = visibleSeries(c.get("auth").scope, seriesRows).map((s) => {
    const marks = markRows
      .filter((m) => m.seriesId === s.id)
      .map((m) => ({ month: m.month, status: m.status as (typeof MARK_STATUSES)[number], note: m.note }));
    const { months, summary } = computeCoverage(
      { cadence: s.cadence as RecurringCadence, startMonth: s.startMonth, endMonth: s.endMonth },
      from,
      to,
      docsBySeries.get(s.id) ?? new Map(),
      marks,
    );
    return {
      id: s.id,
      name: s.name,
      cadence: s.cadence,
      ownership: s.ownership,
      entityId: s.entityId,
      accountRef: s.accountRef,
      startMonth: s.startMonth,
      endMonth: s.endMonth,
      months,
      summary,
    };
  });

  return c.json({ from, to, series });
});

recurringRoute.post("/series/:id/marks", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const seriesId = c.req.param("id");
  const body = await c.req.json<{ month?: unknown; status?: unknown; note?: unknown }>().catch(() => null);
  if (!body || !isValidMonth(body.month)) return c.json({ error: "invalid_month" }, 400);
  if (body.status !== null && !(MARK_STATUSES as readonly unknown[]).includes(body.status)) {
    return c.json({ error: "invalid_status", allowed: [...MARK_STATUSES, null] }, 400);
  }
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 200) : null;

  const db = createDb(c.env.DB);
  const [s] = await db.select().from(recurringSeries).where(eq(recurringSeries.id, seriesId)).limit(1);
  if (!s) return c.json({ error: "not_found" }, 404);
  if (!visibleSeries(auth.scope, [s]).length) return c.json({ error: "forbidden" }, 403);

  const month = body.month;
  const where = and(eq(recurringMonthMarks.seriesId, seriesId), eq(recurringMonthMarks.month, month));
  if (body.status === null) {
    await db.delete(recurringMonthMarks).where(where);
  } else {
    const status = body.status as (typeof MARK_STATUSES)[number];
    await db
      .insert(recurringMonthMarks)
      .values({ seriesId, month, status, note, createdByMemberId: auth.memberId })
      .onConflictDoUpdate({
        target: [recurringMonthMarks.seriesId, recurringMonthMarks.month],
        set: { status, note, createdByMemberId: auth.memberId },
      });
  }
  return c.json({ ok: true, seriesId, month, status: body.status });
});

recurringRoute.get("/documents/:id", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const [doc] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  if (!doc) return c.json({ error: "not_found" }, 404);
  const [fields, seriesRows] = await Promise.all([
    db.select().from(documentExtractedFields).where(eq(documentExtractedFields.documentId, id)),
    db.select().from(recurringSeries),
  ]);
  const byKey = new Map(fields.map((f) => [f.fieldKey, f]));
  const billingMonths = fields
    .filter((f) => isBillingMonthFieldKey(f.fieldKey) && isValidMonth(f.value))
    .sort((a, b) => (a.value ?? "").localeCompare(b.value ?? ""));
  const seriesField = byKey.get(RECURRING_SERIES_FIELD_KEY);

  const suggestion = {
    series: suggestSeries(seriesRows, {
      vendorTaxId: byKey.get("vendorTaxId")?.value ?? null,
      vendorNameRaw: doc.vendorNameRaw,
      texts: [doc.displayName, ...fields.map((f) => f.value)].filter((t): t is string => !!t),
    }),
    billingMonths: suggestBillingMonths({
      invoicePeriod: byKey.get("invoicePeriod")?.value ?? null,
      invoiceDate: doc.invoiceDate,
      docDate: doc.docDate,
    }),
  };

  return c.json({
    documentId: id,
    billingMonths: billingMonths.map((f) => f.value),
    billingMonthsConfirmed: billingMonths.length > 0 && billingMonths.every((f) => f.isUserConfirmed),
    recurringSeriesId: seriesField?.value ?? null,
    recurringSeriesConfirmed: !!seriesField?.isUserConfirmed,
    projectCode: doc.projectCode,
    suggestion,
  });
});

recurringRoute.post("/documents/:id", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const body = await c.req
    .json<{ billingMonths?: unknown; recurringSeriesId?: unknown; projectCode?: unknown }>()
    .catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);

  const db = createDb(c.env.DB);
  const [doc] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  if (!doc) return c.json({ error: "not_found" }, 404);

  let months: string[] | undefined;
  if (body.billingMonths !== undefined) {
    if (!Array.isArray(body.billingMonths) || !body.billingMonths.every(isValidMonth)) {
      return c.json({ error: "invalid_billing_months", message: "billingMonths 必須是 YYYY-MM 陣列" }, 400);
    }
    months = [...new Set(body.billingMonths as string[])].sort();
    if (months.length > MAX_BILLING_MONTHS_PER_DOCUMENT) return c.json({ error: "too_many_billing_months" }, 400);
  }
  let seriesId: string | null | undefined;
  if (body.recurringSeriesId !== undefined) {
    if (body.recurringSeriesId !== null && typeof body.recurringSeriesId !== "string") return c.json({ error: "invalid_series" }, 400);
    seriesId = body.recurringSeriesId as string | null;
    if (seriesId) {
      const [s] = await db.select({ id: recurringSeries.id }).from(recurringSeries).where(eq(recurringSeries.id, seriesId)).limit(1);
      if (!s) return c.json({ error: "series_not_found" }, 400);
    }
  }
  let projectCode: string | null | undefined;
  if (body.projectCode !== undefined) {
    const raw = typeof body.projectCode === "string" ? body.projectCode.trim().toUpperCase() : body.projectCode;
    if (raw !== null && raw !== "" && (typeof raw !== "string" || !PROJECT_CODE_RE.test(raw))) {
      return c.json({ error: "invalid_project_code", message: "專案代碼格式為 AP_YYNNN" }, 400);
    }
    projectCode = raw ? (raw as string) : null;
  }

  const now = new Date().toISOString();
  const confirmed = {
    extractionSource: "user_input" as const,
    confidence: 100,
    isUserConfirmed: true,
    confirmedByMemberId: auth.memberId,
    confirmedAt: now,
  };
  const existing = await db.select().from(documentExtractedFields).where(eq(documentExtractedFields.documentId, id));
  const statements: unknown[] = [];

  if (months) {
    const staleKeys = existing.filter((f) => isBillingMonthFieldKey(f.fieldKey)).map((f) => f.fieldKey);
    if (staleKeys.length) {
      statements.push(
        db
          .delete(documentExtractedFields)
          .where(and(eq(documentExtractedFields.documentId, id), inArray(documentExtractedFields.fieldKey, staleKeys))),
      );
    }
    months.forEach((m, i) =>
      statements.push(
        db.insert(documentExtractedFields).values({
          documentId: id,
          fieldKey: billingMonthFieldKey(i),
          label: i === 0 ? "帳單月份" : `帳單月份 ${i + 1}`,
          value: m,
          normalizedValue: m,
          sortOrder: 900 + i,
          ...confirmed,
        }),
      ),
    );
  }
  if (seriesId !== undefined) {
    if (seriesId === null) {
      statements.push(
        db
          .delete(documentExtractedFields)
          .where(and(eq(documentExtractedFields.documentId, id), eq(documentExtractedFields.fieldKey, RECURRING_SERIES_FIELD_KEY))),
      );
    } else {
      statements.push(
        db
          .insert(documentExtractedFields)
          .values({ documentId: id, fieldKey: RECURRING_SERIES_FIELD_KEY, label: "定期帳單", value: seriesId, sortOrder: 899, ...confirmed })
          .onConflictDoUpdate({
            target: [documentExtractedFields.documentId, documentExtractedFields.fieldKey],
            set: { value: seriesId, ...confirmed },
          }),
      );
    }
  }
  if (projectCode !== undefined) {
    statements.push(db.update(documents).set({ projectCode, updatedAt: now }).where(eq(documents.id, id)));
  }
  if (!statements.length) return c.json({ ok: true, unchanged: true });

  const parts = [
    months ? `帳單月份 ${months.join("、") || "(清空)"}` : null,
    seriesId !== undefined ? `定期帳單 ${seriesId ?? "(清空)"}` : null,
    projectCode !== undefined ? `專案代碼 ${projectCode ?? "(清空)"}` : null,
  ].filter(Boolean);
  statements.push(
    db.insert(activityLog).values({
      entityType: "document",
      entityId: id,
      kind: "review",
      text: `${auth.name ?? auth.email ?? "系統"} 確認${parts.join(";")}`,
      actorMemberId: auth.memberId,
    }),
  );
  await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
  return c.json({ ok: true, billingMonths: months, recurringSeriesId: seriesId, projectCode });
});
