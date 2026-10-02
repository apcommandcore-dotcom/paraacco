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
// 2026-09-29(CODE_TASK_recurring-bills-single-page_20260929_V1.01.md):/recurring「定期繳費」成為唯一入口,
// recurring_series 是主表(migration 0010 補上 category/amount_cents/payment_method/next_due_date/remind_days/
// needs_document)。新增:
//   POST /api/recurring/series                      新增項目
//   POST /api/recurring/series/:id                  編輯項目(部分欄位)
//   POST /api/recurring/series/:id/advance          已繳 → 下期繳費日依 cadence 推一期(取代 /warranty/:id/advance)
//   GET  /api/recurring/series/:id/documents        這個項目所有月份的帳單文件
//
// 月份與文件的對應存在 document_extracted_fields(見 @paraacco/domain 的 recurring.ts),催繳判斷沿用
// document_case_links.role(reminder/penalty/enforcement),不另開欄位。

import { Hono } from "hono";
import { and, asc, eq, inArray, like, or } from "drizzle-orm";
import {
  activityLog,
  createDb,
  documentCaseLinks,
  documentExtractedFields,
  documents,
  entities,
  recurringMatchReviews,
  recurringMonthMarks,
  recurringPeriods,
  recurringSeries,
  statementLines,
  vendors,
} from "@paraacco/db";
import {
  BILLING_MONTH_FIELD_KEY,
  MAX_BILLING_MONTHS_PER_DOCUMENT,
  PAYMENT_METHODS,
  RECURRING_CADENCES,
  RECURRING_CATEGORIES,
  RECURRING_SERIES_FIELD_KEY,
  AMOUNT_MODES,
  DUE_RULES,
  addMonths,
  autoNotRequiredMarks,
  periodDisplayStatus,
  type DocumentRole,
  type PeriodDisplayStatus,
  type PeriodStatus,
  billingMonthFieldKey,
  computeCoverage,
  recurringDueStatus,
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
import {
  attachDocumentManually,
  backfillNewSeries,
  billGraceDays,
  decideReview,
  detachDocument,
  markCurrentPeriodPaid,
  matchRecurringDocument,
  setPeriodStatusManually,
  statementCoveredThrough,
  undoBackfill,
  type Actor,
} from "../recurring-matching";

export const recurringRoute = new Hono<{ Bindings: Bindings }>();

const REMINDER_ROLES = ["reminder", "penalty", "enforcement"];
const MARK_STATUSES = ["not_required", "encrypted"] as const;
const PROJECT_CODE_RE = /^AP_\d{5}$/;
const EXCLUDED_DOC_STATUSES = new Set(["ignored", "dup"]);

function visibleSeries<T extends { ownership: string | null }>(scope: string | null, rows: T[]): T[] {
  // ownership 為 null/pending(未分流)視為公司範圍可見;'per' 只有 personal_corp 看得到。
  return rows.filter((s) => canAccessOwnership(scope, s.ownership && s.ownership !== "pending" ? s.ownership : "corp"));
}

type SeriesRow = typeof recurringSeries.$inferSelect;

type PeriodRowDb = typeof recurringPeriods.$inferSelect;

interface PeriodCtx {
  periodsBySeries: Map<string, PeriodRowDb[]>;
  coveredThrough: string | null;
  graceDays: number;
  now: Date;
}

async function loadPeriodCtx(db: ReturnType<typeof createDb>): Promise<PeriodCtx> {
  const [rows, coveredThrough, graceDays] = await Promise.all([db.select().from(recurringPeriods), statementCoveredThrough(db), billGraceDays(db)]);
  const periodsBySeries = new Map<string, PeriodRowDb[]>();
  for (const r of rows) periodsBySeries.set(r.seriesId, [...(periodsBySeries.get(r.seriesId) ?? []), r]);
  for (const list of periodsBySeries.values()) list.sort((a, b) => a.periodKey.localeCompare(b.periodKey));
  return { periodsBySeries, coveredThrough, graceDays, now: new Date() };
}

function displayOf(p: PeriodRowDb, s: SeriesRow, ctx: PeriodCtx): PeriodDisplayStatus {
  return periodDisplayStatus(
    { months: JSON.parse(p.periodMonths) as string[], status: p.status as PeriodStatus, dueDate: p.dueDate, billDocId: p.billDocId, statementLineId: p.statementLineId },
    s,
    ctx.now,
    { statementCoveredThrough: ctx.coveredThrough, graceDays: ctx.graceDays },
  );
}

/** 清單/詳情共用:主檔供應商名稱;有期次時,下期繳費日 = 最早一筆未付期次的期限(V1.04 2.3,不再手動維護),
 * 本期金額 = 最新一期帳單/扣款金額(另附上一期),本期狀態依第四節規則即時算。還沒有期次的項目沿用舊欄位。 */
function serializeSeries(s: SeriesRow, vendorNames: Map<string, string>, ctx?: PeriodCtx) {
  const periods = ctx?.periodsBySeries.get(s.id) ?? [];
  const base = { ...s, vendorName: s.vendorId ? (vendorNames.get(s.vendorId) ?? null) : null, dueStatus: recurringDueStatus(s.nextDueDate, s.remindDays, ctx?.now) };
  if (!ctx || !periods.length) return { ...base, periodCount: 0, currentStatus: null, currentPeriodKey: null, previousAmountCents: null };
  const unpaid = periods.filter((p) => p.status !== "paid" && p.status !== "waived");
  const today = new Date(ctx.now.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
  // 本期:最早一筆「已過期或已有帳單」的未付期次;都沒有就是下一筆未付期次;全部付清就是最新一期。
  const current = unpaid.find((p) => p.billDocId || p.statementLineId || (p.dueDate && p.dueDate <= today)) ?? unpaid[0] ?? periods[periods.length - 1];
  const withAmount = periods.filter((p) => p.amountCents != null);
  return {
    ...base,
    nextDueDate: unpaid.find((p) => p.dueDate)?.dueDate ?? s.nextDueDate,
    amountCents: withAmount.length ? withAmount[withAmount.length - 1].amountCents : s.amountCents,
    previousAmountCents: withAmount.length > 1 ? withAmount[withAmount.length - 2].amountCents : null,
    periodCount: periods.length,
    currentPeriodKey: current.periodKey,
    currentStatus: displayOf(current, s, ctx),
  };
}

async function vendorNameMap(db: ReturnType<typeof createDb>) {
  const rows = await db.select({ id: vendors.id, name: vendors.name }).from(vendors);
  return new Map(rows.map((v) => [v.id, v.name]));
}

recurringRoute.get("/series", async (c) => {
  const db = createDb(c.env.DB);
  const [rows, names, ctx] = await Promise.all([db.select().from(recurringSeries).orderBy(recurringSeries.id), vendorNameMap(db), loadPeriodCtx(db)]);
  return c.json({ series: visibleSeries(c.get("auth").scope, rows).map((s) => serializeSeries(s, names, ctx)) });
});

// ---- 期次(V1.04 第二、三、五節)----
const actorOf = (auth: { memberId: string | null; name: string | null; email: string | null }): Actor => ({ memberId: auth.memberId, name: auth.name ?? auth.email ?? null });

// 項目詳情:期次清單(新到舊),每期帶帳單/證明/扣款與畫面狀態。
recurringRoute.get("/series/:id/periods", async (c) => {
  const id = c.req.param("id");
  const db = createDb(c.env.DB);
  const [s] = await db.select().from(recurringSeries).where(eq(recurringSeries.id, id)).limit(1);
  if (!s) return c.json({ error: "not_found" }, 404);
  if (!visibleSeries(c.get("auth").scope, [s]).length) return c.json({ error: "forbidden" }, 403);
  const ctx = await loadPeriodCtx(db);
  const periods = [...(ctx.periodsBySeries.get(id) ?? [])].reverse();
  const lineIds = periods.map((p) => p.statementLineId).filter((x): x is number => x != null);
  const lines = lineIds.length ? await db.select().from(statementLines).where(inArray(statementLines.id, lineIds.slice(0, 90))) : [];
  return c.json({
    seriesId: id,
    periods: periods.map((p) => ({
      ...p,
      periodMonths: JSON.parse(p.periodMonths) as string[],
      displayStatus: displayOf(p, s, ctx),
      statementLine: lines.find((l) => l.id === p.statementLineId) ?? null,
    })),
  });
});

recurringRoute.post("/periods/:id/attach", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{ documentId?: string; role?: string }>().catch(() => null);
  if (!body?.documentId) return c.json({ error: "missing_document_id" }, 400);
  if (body.role && !["bill", "proof", "bill_and_proof"].includes(body.role)) return c.json({ error: "invalid_role" }, 400);
  const r = await attachDocumentManually(createDb(c.env.DB), Number(c.req.param("id")), body.documentId, body.role as DocumentRole | undefined, actorOf(auth));
  if ("error" in r) return c.json(r, 404);
  return c.json({ ok: r.outcome === "attached", ...r }, r.outcome === "attached" ? 200 : 409);
});

recurringRoute.post("/periods/:id/detach", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{ documentId?: string }>().catch(() => null);
  if (!body?.documentId) return c.json({ error: "missing_document_id" }, 400);
  const r = await detachDocument(createDb(c.env.DB), Number(c.req.param("id")), body.documentId, actorOf(auth));
  return "error" in r ? c.json(r, 404) : c.json(r);
});

// 手動標已繳(無證明)/ 無需帳單 / 依掛上的文件重算
recurringRoute.post("/periods/:id/status", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{ action?: string }>().catch(() => null);
  if (!body || !["paid", "waived", "reset"].includes(body.action ?? "")) return c.json({ error: "invalid_action", allowed: ["paid", "waived", "reset"] }, 400);
  const r = await setPeriodStatusManually(createDb(c.env.DB), Number(c.req.param("id")), body.action as "paid" | "waived" | "reset", actorOf(auth));
  return "error" in r ? c.json(r, 404) : c.json(r);
});

// 待覆核掛期(中信心、重複帳單、對帳單多筆命中/金額不符、統編未建檔)
recurringRoute.get("/reviews", async (c) => {
  const db = createDb(c.env.DB);
  const status = c.req.query("status") ?? "pending";
  const documentId = c.req.query("documentId");
  const rows = await db
    .select()
    .from(recurringMatchReviews)
    .where(and(eq(recurringMatchReviews.status, status), documentId ? eq(recurringMatchReviews.documentId, documentId) : undefined))
    .orderBy(asc(recurringMatchReviews.id));
  return c.json({ reviews: rows });
});

recurringRoute.post("/reviews/:id/:decision", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const decision = c.req.param("decision");
  if (decision !== "accept" && decision !== "reject") return c.json({ error: "invalid_decision" }, 400);
  const body = await c.req.json<{ seriesId?: string; periodKey?: string }>().catch(() => ({}) as { seriesId?: string; periodKey?: string });
  const r = await decideReview(createDb(c.env.DB), Number(c.req.param("id")), decision, actorOf(auth), body);
  return "error" in r ? c.json(r, 409) : c.json(r);
});

// 新增項目後的回溯掛期撤回(把剛剛 POST /series 回傳的 backfill 內容原樣送回)
recurringRoute.post("/series/:id/backfill/undo", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<{ attachedDocs?: Array<{ documentId: string }>; attachedLines?: number[] }>().catch(() => ({}));
  return c.json(await undoBackfill(createDb(c.env.DB), c.req.param("id"), body, actorOf(auth)));
});

// ---- 新增/編輯項目(原 /warranty 的定期繳費欄位 + series 的起訖月份、match_rule)----
const SERIES_OWNERSHIPS = ["per", "corp", "advance", "custody", "pending"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface SeriesBody {
  name?: unknown;
  category?: unknown;
  entityId?: unknown;
  ownership?: unknown;
  vendorId?: unknown;
  accountRef?: unknown;
  cadence?: unknown;
  startMonth?: unknown;
  endMonth?: unknown;
  matchRule?: unknown;
  amountCents?: unknown;
  paymentMethod?: unknown;
  nextDueDate?: unknown;
  remindDays?: unknown;
  needsDocument?: unknown;
  note?: unknown;
  dueRule?: unknown;
  dueDay?: unknown;
  amountMode?: unknown;
  requireProof?: unknown;
}

type SeriesPatch = Partial<typeof recurringSeries.$inferInsert>;

/** 驗證並轉成 DB 欄位。partial=true(編輯)時沒給的欄位不動。回傳 { field } 代表第一個不合法的欄位。 */
async function parseSeriesBody(
  db: ReturnType<typeof createDb>,
  body: SeriesBody,
  partial: boolean,
  current?: SeriesRow,
): Promise<{ patch: SeriesPatch } | { field: string }> {
  const has = (k: keyof SeriesBody) => body[k] !== undefined;
  const patch: SeriesPatch = {};
  const optText = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

  if (!partial || has("name")) {
    if (typeof body.name !== "string" || !body.name.trim()) return { field: "name" };
    patch.name = body.name.trim().slice(0, 100);
  }
  if (!partial || has("cadence")) {
    if (!(RECURRING_CADENCES as readonly unknown[]).includes(body.cadence)) return { field: "cadence" };
    patch.cadence = body.cadence as string;
  }
  if (!partial || has("startMonth")) {
    if (!isValidMonth(body.startMonth)) return { field: "startMonth" };
    patch.startMonth = body.startMonth;
  }
  if (has("endMonth")) {
    if (body.endMonth !== null && body.endMonth !== "" && !isValidMonth(body.endMonth)) return { field: "endMonth" };
    patch.endMonth = isValidMonth(body.endMonth) ? body.endMonth : null;
  }
  const start = patch.startMonth ?? current?.startMonth;
  const end = patch.endMonth !== undefined ? patch.endMonth : current?.endMonth;
  if (start && end && end < start) return { field: "endMonth" };
  if (has("category")) {
    if (body.category !== null && body.category !== "" && !(RECURRING_CATEGORIES as readonly unknown[]).includes(body.category)) return { field: "category" };
    patch.category = optText(body.category);
  }
  if (has("ownership")) {
    if (body.ownership !== null && body.ownership !== "" && !SERIES_OWNERSHIPS.includes(body.ownership as string)) return { field: "ownership" };
    patch.ownership = optText(body.ownership);
  }
  if (has("entityId")) {
    const v = optText(body.entityId);
    if (v) {
      const [e] = await db.select({ id: entities.id }).from(entities).where(eq(entities.id, v)).limit(1);
      if (!e) return { field: "entityId" };
    }
    patch.entityId = v;
  }
  if (has("vendorId")) {
    const v = optText(body.vendorId);
    if (v) {
      const [e] = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, v)).limit(1);
      if (!e) return { field: "vendorId" };
    }
    patch.vendorId = v;
  }
  if (has("paymentMethod")) {
    if (body.paymentMethod !== null && body.paymentMethod !== "" && !(PAYMENT_METHODS as readonly unknown[]).includes(body.paymentMethod)) return { field: "paymentMethod" };
    patch.paymentMethod = optText(body.paymentMethod);
  }
  if (has("amountCents")) {
    if (body.amountCents !== null && (typeof body.amountCents !== "number" || !Number.isInteger(body.amountCents) || body.amountCents < 0)) return { field: "amountCents" };
    patch.amountCents = body.amountCents as number | null;
  }
  if (has("nextDueDate")) {
    if (body.nextDueDate !== null && body.nextDueDate !== "" && !(typeof body.nextDueDate === "string" && DATE_RE.test(body.nextDueDate))) return { field: "nextDueDate" };
    patch.nextDueDate = optText(body.nextDueDate);
  }
  if (has("remindDays")) {
    if (typeof body.remindDays !== "number" || !Number.isInteger(body.remindDays) || body.remindDays < 0 || body.remindDays > 365) return { field: "remindDays" };
    patch.remindDays = body.remindDays;
  }
  if (has("needsDocument")) {
    if (typeof body.needsDocument !== "boolean") return { field: "needsDocument" };
    patch.needsDocument = body.needsDocument;
  }
  if (has("matchRule")) {
    if (body.matchRule === null || body.matchRule === "") patch.matchRule = null;
    else if (typeof body.matchRule === "object" && !Array.isArray(body.matchRule)) patch.matchRule = JSON.stringify(body.matchRule);
    else if (typeof body.matchRule === "string") {
      try {
        const v = JSON.parse(body.matchRule) as unknown;
        if (!v || typeof v !== "object" || Array.isArray(v)) return { field: "matchRule" };
        patch.matchRule = JSON.stringify(v);
      } catch {
        return { field: "matchRule" };
      }
    } else return { field: "matchRule" };
  }
  if (has("dueRule")) {
    if (!(DUE_RULES as readonly unknown[]).includes(body.dueRule)) return { field: "dueRule" };
    patch.dueRule = body.dueRule as string;
  }
  if (has("dueDay")) {
    if (body.dueDay !== null && (typeof body.dueDay !== "number" || !Number.isInteger(body.dueDay) || body.dueDay < 1 || body.dueDay > 31)) return { field: "dueDay" };
    patch.dueDay = body.dueDay as number | null;
  }
  if (has("amountMode")) {
    if (!(AMOUNT_MODES as readonly unknown[]).includes(body.amountMode)) return { field: "amountMode" };
    patch.amountMode = body.amountMode as string;
  }
  if (has("requireProof")) {
    if (typeof body.requireProof !== "boolean") return { field: "requireProof" };
    patch.requireProof = body.requireProof;
  }
  if (has("accountRef")) patch.accountRef = optText(body.accountRef)?.slice(0, 100) ?? null;
  if (has("note")) patch.note = optText(body.note)?.slice(0, 500) ?? null;
  return { patch };
}

async function nextSeriesId(db: ReturnType<typeof createDb>): Promise<string> {
  const rows = await db.select({ id: recurringSeries.id }).from(recurringSeries);
  const max = rows.reduce((m, r) => Math.max(m, Number(/^RCS-(\d+)$/.exec(r.id)?.[1] ?? 0)), 0);
  return `RCS-${String(max + 1).padStart(3, "0")}`;
}

recurringRoute.post("/series", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json<SeriesBody>().catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);
  const db = createDb(c.env.DB);
  const parsed = await parseSeriesBody(db, body, false);
  if ("field" in parsed) return c.json({ error: "invalid_field", field: parsed.field }, 400);
  const id = await nextSeriesId(db);
  await db.batch([
    db.insert(recurringSeries).values({ ...(parsed.patch as typeof recurringSeries.$inferInsert), id }),
    db.insert(activityLog).values({
      entityType: "recurring_series",
      entityId: id,
      kind: "import",
      text: `${auth.name ?? auth.email ?? "系統"} 新增定期繳費項目:${parsed.patch.name}`,
      actorMemberId: auth.memberId,
    }),
  ]);
  // V1.04 5.3:新增單一項目後立即回溯掛期(不必等確認),結果回給畫面顯示,可一鍵撤回(/series/:id/backfill/undo)。
  const backfill = await backfillNewSeries(db, id, actorOf(auth));
  return c.json({ ok: true, id, backfill }, 201);
});

recurringRoute.post("/series/:id", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const body = await c.req.json<SeriesBody>().catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);
  const db = createDb(c.env.DB);
  const [current] = await db.select().from(recurringSeries).where(eq(recurringSeries.id, id)).limit(1);
  if (!current) return c.json({ error: "not_found" }, 404);
  if (!visibleSeries(auth.scope, [current]).length) return c.json({ error: "forbidden" }, 403);
  const parsed = await parseSeriesBody(db, body, true, current);
  if ("field" in parsed) return c.json({ error: "invalid_field", field: parsed.field }, 400);
  if (!Object.keys(parsed.patch).length) return c.json({ ok: true, unchanged: true });
  await db.update(recurringSeries).set({ ...parsed.patch, updatedAt: new Date().toISOString() }).where(eq(recurringSeries.id, id));
  return c.json({ ok: true });
});

// 「已繳」(V1.04 3.3):把目前未付的那一期標成手動已繳(paid_source='manual',畫面標「無證明」),不再直接推日期。
// 還沒有任何期次的項目只建立本期那一期。可帶 { amountCents } 記這期金額。
recurringRoute.post("/series/:id/advance", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const db = createDb(c.env.DB);
  const [s] = await db.select().from(recurringSeries).where(eq(recurringSeries.id, id)).limit(1);
  if (!s) return c.json({ error: "not_found" }, 404);
  if (!visibleSeries(auth.scope, [s]).length) return c.json({ error: "forbidden" }, 403);
  const r = await markCurrentPeriodPaid(db, id, actorOf(auth));
  if ("error" in r) return c.json(r, 404);
  return c.json(r);
});

// 這個項目所有月份的帳單文件(DOC 連結、帳單月份、金額)。
recurringRoute.get("/series/:id/documents", async (c) => {
  const id = c.req.param("id");
  const db = createDb(c.env.DB);
  const [s] = await db.select().from(recurringSeries).where(eq(recurringSeries.id, id)).limit(1);
  if (!s) return c.json({ error: "not_found" }, 404);
  if (!visibleSeries(c.get("auth").scope, [s]).length) return c.json({ error: "forbidden" }, 403);
  const docIds = db
    .select({ id: documentExtractedFields.documentId })
    .from(documentExtractedFields)
    .where(and(eq(documentExtractedFields.fieldKey, RECURRING_SERIES_FIELD_KEY), eq(documentExtractedFields.value, id)));
  const [docRows, monthRows] = await Promise.all([
    db
      .select({
        id: documents.id,
        status: documents.status,
        invoiceDate: documents.invoiceDate,
        docDate: documents.docDate,
        amountCents: documents.amountCents,
        currency: documents.currency,
        displayName: documents.displayName,
        vendorNameRaw: documents.vendorNameRaw,
      })
      .from(documents)
      .where(inArray(documents.id, docIds)),
    db
      .select({ documentId: documentExtractedFields.documentId, fieldKey: documentExtractedFields.fieldKey, value: documentExtractedFields.value })
      .from(documentExtractedFields)
      .where(and(inArray(documentExtractedFields.documentId, docIds), like(documentExtractedFields.fieldKey, `${BILLING_MONTH_FIELD_KEY}%`))),
  ]);
  const months = new Map<string, string[]>();
  for (const m of monthRows) {
    if (isBillingMonthFieldKey(m.fieldKey) && isValidMonth(m.value)) months.set(m.documentId, [...(months.get(m.documentId) ?? []), m.value]);
  }
  const out = docRows
    .map((d) => ({ ...d, billingMonths: (months.get(d.id) ?? []).sort(), excluded: EXCLUDED_DOC_STATUSES.has(d.status) }))
    .sort((a, b) => (b.billingMonths[0] ?? b.invoiceDate ?? "").localeCompare(a.billingMonths[0] ?? a.invoiceDate ?? "") || b.id.localeCompare(a.id));
  return c.json({ seriesId: id, documents: out });
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

  const [names, ctx] = await Promise.all([vendorNameMap(db), loadPeriodCtx(db)]);
  const series = visibleSeries(c.get("auth").scope, seriesRows).map((s) => {
    const shape = { cadence: s.cadence as RecurringCadence, startMonth: s.startMonth, endMonth: s.endMonth };
    const docsByMonth = docsBySeries.get(s.id) ?? new Map();
    const manualMarks = markRows
      .filter((m) => m.seriesId === s.id)
      .map((m) => ({ month: m.month, status: m.status as (typeof MARK_STATUSES)[number], note: m.note }));
    // needs_document=0(例:勞退每月扣款,沒有帳單文件):沒有文件的應有月份視為無需帳單(2026-09-29)。
    const marks = s.needsDocument ? manualMarks : autoNotRequiredMarks(shape, from, to, docsByMonth, manualMarks);
    const { months, summary } = computeCoverage(shape, from, to, docsByMonth, marks);
    // V1.04 第五節 4:格子顏色依期次狀態(期次的應有月份 = 期末月);還沒有期次的月份照 V1.01。
    const periodByMonth = new Map((ctx.periodsBySeries.get(s.id) ?? []).map((p) => [(JSON.parse(p.periodMonths) as string[]).slice(-1)[0], p]));
    return {
      ...serializeSeries(s, names, ctx),
      months: months.map((m) => {
        const p = periodByMonth.get(m.month);
        return p ? { ...m, periodId: p.id, periodStatus: displayOf(p, s, ctx), statementLineId: p.statementLineId, proofDocId: p.proofDocId } : m;
      }),
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
  // V1.04:人工確認了定期帳單 → 立刻掛到對應期次(帳單/證明依文件角色)。
  const period = seriesId ? await matchRecurringDocument(db, id, actorOf(auth)) : null;
  return c.json({ ok: true, billingMonths: months, recurringSeriesId: seriesId, projectCode, period });
});
