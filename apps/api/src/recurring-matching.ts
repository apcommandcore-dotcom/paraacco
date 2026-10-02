// 定期繳費自動掛期 —— 2026-10-01,CODE_TASK_recurring-bills-single-page_20260929_V1.04.md 第二~六節。
// 規則在 @paraacco/domain 的 recurring-periods.ts;這裡負責讀寫 D1:
//   ensurePeriods()                 補「已過的期次 + 下一期」(每日排程只補已經有期次的項目,歷史期次要等 Theo 確認回溯後才建)
//   matchRecurringDocument()        文件 → 項目/期次(pipeline 最後一步、覆核確認時呼叫)
//   matchRecurringStatementLine()   對帳單明細 → 期次(statement_lines 寫入後呼叫)
//   手動後備:attachDocument / detachDocument / markPaidManual / waive;待覆核:acceptReview / rejectReview
// 文件掛上期次時,同步寫 document_extracted_fields 的 recurring_series_id / billing_month(V1.01 的「一般列表隱藏定期繳費」、
// 月報表分段、月份檢核都靠這兩個欄位),sourceNote 標「自動掛期」;人工確認過(isUserConfirmed)的不覆蓋。

import { and, asc, eq, inArray, isNotNull, like, max, or, sql } from "drizzle-orm";
import {
  activityLog,
  appSettings,
  documentExtractedFields,
  documentFiles,
  documents,
  recurringMatchReviews,
  recurringPeriods,
  recurringSeries,
  statementLines,
  vendors,
  type Db,
} from "@paraacco/db";
import {
  BILLING_MONTH_FIELD_KEY,
  BILL_GRACE_DAYS_KEY,
  DEFAULT_BILL_GRACE_DAYS,
  RECURRING_SERIES_FIELD_KEY,
  addMonths,
  applyDocumentToPeriod,
  billingMonthFieldKey,
  documentRoleOf,
  estimateDueDate,
  expectedPeriods,
  isBillingMonthFieldKey,
  isValidMonth,
  matchDocumentSeries,
  matchStatementDebit,
  periodForDocument,
  periodForMonth,
  resolveVendorTaxId,
  type DocumentRole,
  type PeriodPatch,
  type PeriodRef,
  type PeriodSeries,
  type PeriodStatus,
  type RecurringCadence,
} from "@paraacco/domain";

export interface Actor {
  memberId: string | null;
  name: string | null;
}
const SYSTEM: Actor = { memberId: null, name: "系統" };
const AUTO_NOTE = "自動掛期(CODE_TASK_recurring-bills-single-page V1.04)";

type SeriesRow = typeof recurringSeries.$inferSelect;
type PeriodDbRow = typeof recurringPeriods.$inferSelect;

export function toPeriodSeries(s: SeriesRow, vendorTaxId: string | null): PeriodSeries {
  return {
    id: s.id,
    cadence: s.cadence as RecurringCadence,
    startMonth: s.startMonth,
    endMonth: s.endMonth,
    paymentMethod: s.paymentMethod,
    dueRule: s.dueRule,
    dueDay: s.dueDay,
    amountMode: s.amountMode,
    amountCents: s.amountCents,
    requireProof: s.requireProof,
    remindDays: s.remindDays,
    needsDocument: s.needsDocument,
    matchRule: s.matchRule,
    vendorTaxId,
  };
}

export async function loadPeriodSeries(db: Db): Promise<PeriodSeries[]> {
  const rows = await db.select({ s: recurringSeries, taxId: vendors.taxId }).from(recurringSeries).leftJoin(vendors, eq(vendors.id, recurringSeries.vendorId));
  return rows.map((r) => toPeriodSeries(r.s, r.taxId ?? null));
}

export async function billGraceDays(db: Db): Promise<number> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, BILL_GRACE_DAYS_KEY)).limit(1);
  const n = Number(row?.value);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_BILL_GRACE_DAYS;
}

/** 已匯入的對帳單涵蓋到哪一天(待對帳 vs 逾期未繳的分界)。 */
export async function statementCoveredThrough(db: Db): Promise<string | null> {
  const [row] = await db.select({ d: max(statementLines.date) }).from(statementLines);
  return row?.d ?? null;
}

function currentMonthTaipei(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3600e3).toISOString().slice(0, 7);
}

function periodInsert(series: PeriodSeries, ref: PeriodRef, extra: Partial<typeof recurringPeriods.$inferInsert> = {}) {
  const due = estimateDueDate(series, ref.months);
  return {
    seriesId: series.id,
    periodKey: ref.periodKey,
    periodMonths: JSON.stringify(ref.months),
    dueDate: due.dueDate,
    dueDateSource: due.source,
    amountCents: series.amountMode === "fixed" ? series.amountCents : null,
    status: "expected",
    ...extra,
  } satisfies typeof recurringPeriods.$inferInsert;
}

/** 補期次:從 start_month(或 fromMonth)到「本月的下一期」,缺的補 expected。onlyIfHasPeriods:每日排程用,
 * 還沒回溯過(一筆期次都沒有)的項目不碰,避免沒經確認就產生歷史期次。回傳新增筆數。 */
export async function ensurePeriods(
  db: Db,
  opts: { seriesIds?: string[]; onlyIfHasPeriods?: boolean; fromMonth?: string; now?: Date } = {},
): Promise<number> {
  const all = await loadPeriodSeries(db);
  const targets = opts.seriesIds ? all.filter((s) => opts.seriesIds!.includes(s.id)) : all;
  const existing = await db.select({ seriesId: recurringPeriods.seriesId, periodKey: recurringPeriods.periodKey }).from(recurringPeriods);
  const have = new Map<string, Set<string>>();
  for (const e of existing) have.set(e.seriesId, (have.get(e.seriesId) ?? new Set()).add(e.periodKey));
  const toMonth = addMonths(currentMonthTaipei(opts.now), 2); // 涵蓋「下一期」(雙月期末可能在下下個月)
  const rows: Array<typeof recurringPeriods.$inferInsert> = [];
  for (const s of targets) {
    const keys = have.get(s.id);
    if (opts.onlyIfHasPeriods && !keys?.size) continue;
    const from = opts.fromMonth && opts.fromMonth > s.startMonth ? opts.fromMonth : s.startMonth;
    const refs = expectedPeriods(s, from, s.endMonth && s.endMonth < toMonth ? s.endMonth : toMonth);
    for (const ref of refs) if (!keys?.has(ref.periodKey)) rows.push(periodInsert(s, ref));
  }
  for (let i = 0; i < rows.length; i += 8) {
    await db.insert(recurringPeriods).values(rows.slice(i, i + 8)).onConflictDoNothing();
  }
  return rows.length;
}

async function getOrCreatePeriod(db: Db, series: PeriodSeries, ref: PeriodRef): Promise<PeriodDbRow> {
  const where = and(eq(recurringPeriods.seriesId, series.id), eq(recurringPeriods.periodKey, ref.periodKey));
  const [p] = await db.select().from(recurringPeriods).where(where).limit(1);
  if (p) return p;
  await db.insert(recurringPeriods).values(periodInsert(series, ref)).onConflictDoNothing();
  const [created] = await db.select().from(recurringPeriods).where(where).limit(1);
  return created;
}

function patchToSet(patch: PeriodPatch) {
  return { ...patch, updatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// 文件 → 期次
// ---------------------------------------------------------------------------
interface DocContext {
  id: string;
  status: string;
  amountCents: number | null;
  date: string | null;
  billDueDate: string | null;
  vendorTaxId: string | null;
  vendorRegistered: boolean;
  texts: string[];
  role: DocumentRole;
  billingMonths: string[];
  confirmedSeriesId: string | null;
  seriesFieldConfirmed: boolean;
}

async function loadDocContext(db: Db, documentId: string): Promise<DocContext | null> {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc) return null;
  const [fields, files, vendorRows] = await Promise.all([
    db.select().from(documentExtractedFields).where(eq(documentExtractedFields.documentId, documentId)),
    db.select({ localPath: documentFiles.localPath }).from(documentFiles).where(and(eq(documentFiles.documentId, documentId), eq(documentFiles.kind, "original"), eq(documentFiles.isCurrent, true))),
    db.select({ taxId: vendors.taxId }).from(vendors).where(isNotNull(vendors.taxId)),
  ]);
  const by = new Map(fields.map((f) => [f.fieldKey, f]));
  const tax = resolveVendorTaxId({
    qr: by.get("vendorTaxIdQr")?.value,
    printed: by.get("vendorTaxIdPrinted")?.value,
    legacy: by.get("vendorTaxId")?.value,
    legacySource: by.get("vendorTaxIdSource")?.value,
  }).taxId;
  const texts = [doc.displayName, doc.vendorNameRaw, ...fields.map((f) => f.value)].filter((t): t is string => !!t);
  const fileType = files[0]?.localPath?.split("/").pop()?.split("_")[1] ?? null;
  return {
    id: doc.id,
    status: doc.status,
    amountCents: doc.amountCents,
    date: doc.invoiceDate ?? doc.docDate,
    billDueDate: doc.docDate && doc.invoiceDate && doc.docDate > doc.invoiceDate ? doc.docDate : null,
    vendorTaxId: tax,
    vendorRegistered: !!doc.vendorId || (!!tax && vendorRows.some((v) => v.taxId === tax)),
    texts,
    role: documentRoleOf({ documentRole: by.get("document_role")?.value, financeDocType: by.get("finance_doc_type")?.value, fileTypeLabel: fileType, texts }),
    billingMonths: fields.filter((f) => isBillingMonthFieldKey(f.fieldKey) && isValidMonth(f.value)).map((f) => f.value!),
    confirmedSeriesId: by.get(RECURRING_SERIES_FIELD_KEY)?.value ?? null,
    seriesFieldConfirmed: !!by.get(RECURRING_SERIES_FIELD_KEY)?.isUserConfirmed,
  };
}

/** 文件寫上 recurring_series_id 與帳單月份(沒人工確認過才寫;值相同就不動)。 */
function docFieldStatements(db: Db, ctx: DocContext, seriesId: string, ref: PeriodRef) {
  const out: unknown[] = [];
  const sys = { extractionSource: "ai_inference" as const, sourceNote: AUTO_NOTE };
  if (!ctx.seriesFieldConfirmed && ctx.confirmedSeriesId !== seriesId) {
    out.push(
      db
        .insert(documentExtractedFields)
        .values({ documentId: ctx.id, fieldKey: RECURRING_SERIES_FIELD_KEY, label: "定期帳單", value: seriesId, sortOrder: 899, ...sys })
        .onConflictDoUpdate({ target: [documentExtractedFields.documentId, documentExtractedFields.fieldKey], set: { value: seriesId, ...sys } }),
    );
  }
  if (!ctx.billingMonths.length) {
    // 帳單月份記期末月(沿用 V1.01:雙月帳單記應有月份),跟月份檢核一致
    out.push(
      db
        .insert(documentExtractedFields)
        .values({ documentId: ctx.id, fieldKey: billingMonthFieldKey(0), label: "帳單月份", value: ref.expectedMonth, normalizedValue: ref.expectedMonth, sortOrder: 900, ...sys })
        .onConflictDoNothing(),
    );
  }
  return out;
}

async function addReview(db: Db, r: typeof recurringMatchReviews.$inferInsert) {
  const dup = await db
    .select({ id: recurringMatchReviews.id })
    .from(recurringMatchReviews)
    .where(
      and(
        eq(recurringMatchReviews.status, "pending"),
        r.documentId ? eq(recurringMatchReviews.documentId, r.documentId) : eq(recurringMatchReviews.statementLineId, r.statementLineId!),
      ),
    )
    .limit(1);
  if (dup.length) return dup[0].id;
  const [row] = await db.insert(recurringMatchReviews).values(r).returning({ id: recurringMatchReviews.id });
  return row.id;
}

export type DocumentMatchResult =
  | { outcome: "attached"; seriesId: string; periodKey: string; role: DocumentRole; periodId: number }
  | { outcome: "review"; reviewId: number; reason: string }
  | { outcome: "none"; reason: string };

/** 文件 → 項目/期次。已人工確認 recurring_series_id 的文件直接用那個項目;否則依統編 + 用戶號碼找。 */
export async function matchRecurringDocument(db: Db, documentId: string, actor: Actor = SYSTEM): Promise<DocumentMatchResult> {
  const ctx = await loadDocContext(db, documentId);
  if (!ctx) return { outcome: "none", reason: "not_found" };
  if (["ignored", "dup", "failed"].includes(ctx.status)) return { outcome: "none", reason: `status ${ctx.status}` };
  const already = await db
    .select({ id: recurringPeriods.id })
    .from(recurringPeriods)
    .where(or(eq(recurringPeriods.billDocId, documentId), eq(recurringPeriods.proofDocId, documentId)))
    .limit(1);
  if (already.length) return { outcome: "none", reason: "already_attached" };

  const seriesList = await loadPeriodSeries(db);
  let series: PeriodSeries | undefined;
  let confidence = "high";
  let note: string;
  if (ctx.confirmedSeriesId && ctx.seriesFieldConfirmed) {
    series = seriesList.find((s) => s.id === ctx.confirmedSeriesId);
    note = "人工確認的定期帳單";
  } else {
    const m = matchDocumentSeries({ vendorTaxId: ctx.vendorTaxId, vendorRegistered: ctx.vendorRegistered, texts: ctx.texts }, seriesList);
    if (m.kind === "none") return { outcome: "none", reason: "no_series" };
    if (m.kind === "review") {
      const s = seriesList.find((x) => x.id === m.seriesId)!;
      const ref = periodForDocument(s, { billingMonths: ctx.billingMonths, docDate: ctx.date });
      const reviewId = await addReview(db, { seriesId: m.seriesId, periodKey: ref?.periodKey ?? null, documentId, role: ctx.role, reason: m.reason, note: m.note });
      return { outcome: "review", reviewId, reason: m.reason };
    }
    series = seriesList.find((x) => x.id === m.seriesId);
    note = m.reason;
  }
  if (!series) return { outcome: "none", reason: "series_missing" };
  const ref = periodForDocument(series, { billingMonths: ctx.billingMonths, docDate: ctx.date });
  if (!ref) {
    const reviewId = await addReview(db, { seriesId: series.id, documentId, role: ctx.role, reason: "medium_confidence", note: `${note};找不到帳單月份或單據日期,無法決定期次` });
    return { outcome: "review", reviewId, reason: "no_period" };
  }
  return attachToPeriod(db, series, ref, ctx, actor, confidence, note);
}

async function attachToPeriod(db: Db, series: PeriodSeries, ref: PeriodRef, ctx: DocContext, actor: Actor, confidence: string, note: string, roleOverride?: DocumentRole): Promise<DocumentMatchResult> {
  const role = roleOverride ?? ctx.role;
  const period = await getOrCreatePeriod(db, series, ref);
  const { patch, conflict } = applyDocumentToPeriod({ ...period, status: period.status as PeriodStatus }, role, { id: ctx.id, amountCents: ctx.amountCents, billDueDate: ctx.billDueDate, date: ctx.date });
  if (conflict) {
    const reviewId = await addReview(db, {
      seriesId: series.id,
      periodKey: ref.periodKey,
      documentId: ctx.id,
      role,
      reason: "duplicate_bill",
      note: `${ref.periodKey} 已有${conflict === "duplicate_bill" ? "帳單" : "繳費證明"} ${conflict === "duplicate_bill" ? period.billDocId : period.proofDocId},不覆蓋(補單/更正單/重複?)`,
    });
    return { outcome: "review", reviewId, reason: conflict };
  }
  await db.batch([
    db
      .update(recurringPeriods)
      .set({ ...patchToSet(patch), matchConfidence: confidence, matchNote: note })
      .where(eq(recurringPeriods.id, period.id)),
    ...(docFieldStatements(db, ctx, series.id, ref) as never[]),
    db.insert(activityLog).values({
      entityType: "document",
      entityId: ctx.id,
      kind: "review",
      text: `${actor.name ?? "系統"} 掛到定期繳費 ${series.id} ${ref.periodKey}(${role === "bill" ? "帳單" : role === "proof" ? "繳費證明" : "帳單兼證明"};${note})`,
      actorMemberId: actor.memberId,
    }),
  ] as unknown as Parameters<typeof db.batch>[0]);
  return { outcome: "attached", seriesId: series.id, periodKey: ref.periodKey, role, periodId: period.id };
}

// ---------------------------------------------------------------------------
// 對帳單明細 → 期次
// ---------------------------------------------------------------------------
export async function matchRecurringStatementLine(db: Db, lineId: number, actor: Actor = SYSTEM) {
  const [line] = await db.select().from(statementLines).where(eq(statementLines.id, lineId)).limit(1);
  if (!line) return { outcome: "none" as const, reason: "not_found" };
  const used = await db.select({ id: recurringPeriods.id }).from(recurringPeriods).where(eq(recurringPeriods.statementLineId, lineId)).limit(1);
  if (used.length) return { outcome: "none" as const, reason: "already_attached" };
  const seriesList = await loadPeriodSeries(db);
  const periods = await db.select().from(recurringPeriods);
  const input = seriesList.map((s) => ({
    series: s,
    periods: periods.filter((p) => p.seriesId === s.id).map((p) => ({ ...p, months: JSON.parse(p.periodMonths) as string[], status: p.status as never })),
  }));
  const m = matchStatementDebit({ id: line.id, date: line.postDate ?? line.date, amountCents: line.amountCents, description: line.description }, input);
  if (m.kind === "none") return { outcome: "none" as const, reason: "no_match" };
  if (m.kind === "review") {
    const reviewId = await addReview(db, { seriesId: m.seriesId, periodKey: m.periodKey, statementLineId: lineId, role: "debit", reason: m.reason, note: m.note });
    return { outcome: "review" as const, reviewId, reason: m.reason };
  }
  const series = seriesList.find((s) => s.id === m.seriesId)!;
  const period = await getOrCreatePeriod(db, series, periodForMonth(series, m.months[m.months.length - 1]));
  const paid = m.status === "paid";
  await db.batch([
    db
      .update(recurringPeriods)
      .set({
        statementLineId: lineId,
        status: period.status === "paid" ? "paid" : m.status,
        paidAt: paid ? line.date : period.paidAt,
        paidSource: paid && period.status !== "paid" ? "statement" : period.paidSource,
        amountCents: period.amountCents ?? m.amountCents,
        billMissingFlag: m.billMissing && !period.billDocId,
        matchConfidence: "high",
        matchNote: m.note,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(recurringPeriods.id, period.id)),
    db.insert(activityLog).values({
      entityType: "recurring_series",
      entityId: series.id,
      kind: "review",
      text: `${actor.name ?? "系統"} 對帳單扣款掛到 ${series.id} ${m.periodKey}:${m.note}${paid ? "" : "(需繳款證明,狀態:已扣款、缺證明)"}`,
      actorMemberId: actor.memberId,
    }),
  ]);
  return { outcome: "attached" as const, seriesId: series.id, periodKey: m.periodKey, status: m.status };
}

// ---------------------------------------------------------------------------
// 手動後備(3.3)
// ---------------------------------------------------------------------------
function recomputeStatus(p: Pick<PeriodDbRow, "billDocId" | "proofDocId" | "statementLineId">, requireProof: boolean): { status: string; paidSource: string | null } {
  if (p.proofDocId) return { status: "paid", paidSource: "proof" };
  if (p.statementLineId) return requireProof ? { status: "debited", paidSource: null } : { status: "paid", paidSource: "statement" };
  if (p.billDocId) return { status: "billed", paidSource: null };
  return { status: "expected", paidSource: null };
}

export async function attachDocumentManually(db: Db, periodId: number, documentId: string, role: DocumentRole | undefined, actor: Actor) {
  const [p] = await db.select().from(recurringPeriods).where(eq(recurringPeriods.id, periodId)).limit(1);
  if (!p) return { error: "period_not_found" as const };
  const ctx = await loadDocContext(db, documentId);
  if (!ctx) return { error: "document_not_found" as const };
  const series = (await loadPeriodSeries(db)).find((s) => s.id === p.seriesId)!;
  const months = JSON.parse(p.periodMonths) as string[];
  const ref = { periodKey: p.periodKey, months, expectedMonth: months[months.length - 1] };
  return attachToPeriod(db, series, ref, ctx, actor, "manual", "手動掛期", role);
}

/** 拆掉錯掛的文件:期次退回 expected/billed,文件的定期帳單欄位刪掉(回到一般列表)。 */
export async function detachDocument(db: Db, periodId: number, documentId: string, actor: Actor) {
  const [p] = await db.select().from(recurringPeriods).where(eq(recurringPeriods.id, periodId)).limit(1);
  if (!p) return { error: "period_not_found" as const };
  const [s] = await db.select().from(recurringSeries).where(eq(recurringSeries.id, p.seriesId)).limit(1);
  const next = { billDocId: p.billDocId === documentId ? null : p.billDocId, proofDocId: p.proofDocId === documentId ? null : p.proofDocId, statementLineId: p.statementLineId };
  if (next.billDocId === p.billDocId && next.proofDocId === p.proofDocId) return { error: "not_attached" as const };
  const st = recomputeStatus(next, !!s?.requireProof);
  await db.batch([
    db
      .update(recurringPeriods)
      .set({ ...next, status: st.status, paidSource: st.paidSource, paidAt: st.status === "paid" ? p.paidAt : null, updatedAt: new Date().toISOString() })
      .where(eq(recurringPeriods.id, periodId)),
    db
      .delete(documentExtractedFields)
      .where(
        and(
          eq(documentExtractedFields.documentId, documentId),
          or(eq(documentExtractedFields.fieldKey, RECURRING_SERIES_FIELD_KEY), like(documentExtractedFields.fieldKey, `${BILLING_MONTH_FIELD_KEY}%`)),
        ),
      ),
    db.insert(activityLog).values({
      entityType: "document",
      entityId: documentId,
      kind: "review",
      text: `${actor.name ?? "系統"} 從定期繳費 ${p.seriesId} ${p.periodKey} 拆掉這份文件,回到一般列表;期次狀態 ${p.status} → ${st.status}`,
      actorMemberId: actor.memberId,
    }),
  ]);
  return { ok: true as const, status: st.status };
}

export async function setPeriodStatusManually(db: Db, periodId: number, action: "paid" | "waived" | "reset", actor: Actor) {
  const [p] = await db.select().from(recurringPeriods).where(eq(recurringPeriods.id, periodId)).limit(1);
  if (!p) return { error: "period_not_found" as const };
  const [s] = await db.select().from(recurringSeries).where(eq(recurringSeries.id, p.seriesId)).limit(1);
  const now = new Date().toISOString();
  const set =
    action === "paid"
      ? { status: "paid", paidSource: "manual", paidAt: now.slice(0, 10) }
      : action === "waived"
        ? { status: "waived", paidSource: null, paidAt: null }
        : { ...recomputeStatus(p, !!s?.requireProof), paidAt: null };
  await db.batch([
    db.update(recurringPeriods).set({ ...set, updatedAt: now }).where(eq(recurringPeriods.id, periodId)),
    db.insert(activityLog).values({
      entityType: "recurring_series",
      entityId: p.seriesId,
      kind: "review",
      text: `${actor.name ?? "系統"} 手動把 ${p.periodKey} 標為${action === "paid" ? "已繳(無證明)" : action === "waived" ? "無需帳單" : "依掛上的文件重算"}`,
      actorMemberId: actor.memberId,
    }),
  ]);
  return { ok: true as const };
}

/** 原「已繳」(/advance)改成:把最早一期未付的期次標手動已繳;項目還沒有期次時只建立「本期」那一期(不產生歷史)。 */
export async function markCurrentPeriodPaid(db: Db, seriesId: string, actor: Actor, now = new Date()) {
  const series = (await loadPeriodSeries(db)).find((s) => s.id === seriesId);
  if (!series) return { error: "not_found" as const };
  let [open] = await db
    .select()
    .from(recurringPeriods)
    .where(and(eq(recurringPeriods.seriesId, seriesId), inArray(recurringPeriods.status, ["expected", "billed", "overdue", "debited"])))
    .orderBy(asc(recurringPeriods.periodKey))
    .limit(1);
  if (!open) open = await getOrCreatePeriod(db, series, periodForMonth(series, addMonths(currentMonthTaipei(now), -1)));
  await setPeriodStatusManually(db, open.id, "paid", actor);
  return { ok: true as const, periodKey: open.periodKey };
}

// ---------------------------------------------------------------------------
// 待覆核
// ---------------------------------------------------------------------------
export async function decideReview(db: Db, reviewId: number, decision: "accept" | "reject", actor: Actor, overrides: { seriesId?: string; periodKey?: string } = {}) {
  const [r] = await db.select().from(recurringMatchReviews).where(eq(recurringMatchReviews.id, reviewId)).limit(1);
  if (!r || r.status !== "pending") return { error: "not_pending" as const };
  let result: unknown = null;
  if (decision === "accept") {
    const seriesId = overrides.seriesId ?? r.seriesId;
    if (!seriesId) return { error: "missing_series" as const };
    const series = (await loadPeriodSeries(db)).find((s) => s.id === seriesId);
    if (!series) return { error: "series_not_found" as const };
    const key = overrides.periodKey ?? r.periodKey;
    if (!key || !isValidMonth(key)) return { error: "missing_period" as const };
    const ref = periodForMonth(series, key);
    if (r.documentId) {
      const ctx = await loadDocContext(db, r.documentId);
      if (!ctx) return { error: "document_not_found" as const };
      result = await attachToPeriod(db, series, ref, ctx, actor, "manual", `待覆核確認(${r.reason})`, (r.role as DocumentRole) ?? undefined);
    } else if (r.statementLineId) {
      const period = await getOrCreatePeriod(db, series, ref);
      const [line] = await db.select().from(statementLines).where(eq(statementLines.id, r.statementLineId)).limit(1);
      const status = series.requireProof && !period.proofDocId ? "debited" : "paid";
      await db
        .update(recurringPeriods)
        .set({ statementLineId: r.statementLineId, status, paidSource: status === "paid" && !period.proofDocId ? "statement" : period.paidSource, paidAt: status === "paid" ? (period.paidAt ?? line?.date ?? null) : period.paidAt, amountCents: period.amountCents ?? (line ? Math.abs(line.amountCents) : null), updatedAt: new Date().toISOString() })
        .where(eq(recurringPeriods.id, period.id));
      result = { outcome: "attached", periodKey: ref.periodKey };
    }
  }
  await db
    .update(recurringMatchReviews)
    .set({ status: decision === "accept" ? "accepted" : "rejected", decidedByMemberId: actor.memberId, decidedAt: new Date().toISOString() })
    .where(eq(recurringMatchReviews.id, reviewId));
  return { ok: true as const, result };
}

/** 新增單一項目後立即回溯(5.3):對有統編的未掛文件與全部對帳明細跑一次,回傳這次掛上的內容供撤回。 */
export async function backfillNewSeries(db: Db, seriesId: string, actor: Actor) {
  const series = (await loadPeriodSeries(db)).find((s) => s.id === seriesId);
  if (!series) return { error: "not_found" as const };
  const created = await ensurePeriods(db, { seriesIds: [seriesId] });
  const attachedDocs: Array<{ documentId: string; periodKey: string }> = [];
  const reviews: number[] = [];
  const unlinked = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        inArray(documents.status, ["review", "archived", "queued"]),
        sql`NOT EXISTS (SELECT 1 FROM document_extracted_fields e WHERE e.document_id = "documents"."id" AND e.field_key = ${RECURRING_SERIES_FIELD_KEY})`,
      ),
    );
  for (const d of unlinked) {
    const r = await matchRecurringDocument(db, d.id, actor);
    if (r.outcome === "attached" && r.seriesId === seriesId) attachedDocs.push({ documentId: d.id, periodKey: r.periodKey });
    if (r.outcome === "review") reviews.push(r.reviewId);
  }
  const lines = await db.select({ id: statementLines.id }).from(statementLines);
  const attachedLines: number[] = [];
  for (const l of lines) {
    const r = await matchRecurringStatementLine(db, l.id, actor);
    if (r.outcome === "attached" && r.seriesId === seriesId) attachedLines.push(l.id);
  }
  return { ok: true as const, createdPeriods: created, attachedDocs, attachedLines, reviews };
}

/** 撤回剛剛的回溯:拆掉這次掛上的文件與扣款、刪掉這個項目沒有任何掛載的期次。 */
export async function undoBackfill(db: Db, seriesId: string, payload: { attachedDocs?: Array<{ documentId: string }>; attachedLines?: number[] }, actor: Actor) {
  const periods = await db.select().from(recurringPeriods).where(eq(recurringPeriods.seriesId, seriesId));
  for (const d of payload.attachedDocs ?? []) {
    const p = periods.find((x) => x.billDocId === d.documentId || x.proofDocId === d.documentId);
    if (p) await detachDocument(db, p.id, d.documentId, actor);
  }
  for (const lineId of payload.attachedLines ?? []) {
    const p = periods.find((x) => x.statementLineId === lineId);
    if (p) await db.update(recurringPeriods).set({ statementLineId: null, ...recomputeStatus({ ...p, statementLineId: null }, false) }).where(eq(recurringPeriods.id, p.id));
  }
  await db
    .delete(recurringPeriods)
    .where(
      and(
        eq(recurringPeriods.seriesId, seriesId),
        sql`${recurringPeriods.billDocId} IS NULL AND ${recurringPeriods.proofDocId} IS NULL AND ${recurringPeriods.statementLineId} IS NULL AND ${recurringPeriods.status} = 'expected'`,
      ),
    );
  await db.insert(activityLog).values({ entityType: "recurring_series", entityId: seriesId, kind: "review", text: `${actor.name ?? "系統"} 撤回新增項目後的回溯掛期`, actorMemberId: actor.memberId });
  return { ok: true as const };
}
