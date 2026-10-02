// 定期繳費期次與自動掛期 —— 2026-10-01,CODE_TASK_recurring-bills-single-page_20260929_V1.04.md 第二~四節。
// 純函式:API(routes/recurring.ts、recurring-matching.ts)、每日排程、回溯 dry-run 腳本共用。
//
// 項目(recurring_series)= 範本,只建一次;期次(recurring_periods)= 每一期,系統自動產生:
//   - 雙月帳單一期兩個月(2026-10-01 決定),金額不拆;period_key = 起月。
//     既有資料的 billing_month 記的是期末月(例:115年07-08月 → 2026-08),所以期次 = [期末月-1, 期末月]。
//   - 帳單/繳費證明 → matchDocumentSeries() 找項目、periodForMonth() 找期次、applyDocumentToPeriod() 決定欄位。
//   - 對帳單扣款 → matchStatementDebit()。require_proof 項目扣款只到 debited,掛上證明才 paid。
//   - 畫面狀態(未到期/即將繳費/待對帳/帳單未到/缺繳款證明/逾期未繳)由 periodDisplayStatus() 即時算。

import { normalizeTaxId } from "./tax-id";
import { addMonths, expectedMonths, isValidMonth, parseMatchRule, type RecurringCadence, type RecurringMatchRule } from "./recurring";

// ---------------------------------------------------------------------------
// match_rule 擴充(JSON 欄位沿用,不加 migration)
// ---------------------------------------------------------------------------
export interface RecurringMatchRuleV2 extends RecurringMatchRule {
  /** 用戶號碼/電號/水號/保單號,可多個(舊的單一 accountRef 也算進來)。 */
  accountRefs?: string[];
  /** 信用卡/銀行對帳單摘要關鍵字。 */
  statementKeywords?: string[];
  /** 扣款金額與帳單金額允許差額(分),預設 0。 */
  amountTolerance?: number;
  /** 扣款日與繳費期限的比對窗(天),預設 ±10。 */
  dateWindowDays?: number;
}

export function parseMatchRuleV2(raw: string | null | undefined): Required<Pick<RecurringMatchRuleV2, "accountRefs" | "statementKeywords" | "amountTolerance" | "dateWindowDays">> & RecurringMatchRuleV2 {
  const r = parseMatchRule(raw ?? null) as RecurringMatchRuleV2;
  const refs = [...new Set([...(r.accountRefs ?? []), ...(r.accountRef ? [r.accountRef] : [])].map((x) => String(x).trim()).filter(Boolean))];
  return {
    ...r,
    accountRefs: refs,
    statementKeywords: (r.statementKeywords ?? []).map((x) => String(x).trim()).filter(Boolean),
    amountTolerance: Number.isFinite(r.amountTolerance) ? Math.max(0, Number(r.amountTolerance)) : 0,
    dateWindowDays: Number.isFinite(r.dateWindowDays) ? Math.max(0, Number(r.dateWindowDays)) : 10,
  };
}

// ---------------------------------------------------------------------------
// 期次
// ---------------------------------------------------------------------------
export type PeriodStatus = "expected" | "billed" | "debited" | "paid" | "waived" | "overdue";
export type PaidSource = "statement" | "proof" | "manual";
export type DueRule = "bill" | "next_month_day" | "fixed_day";
export const DUE_RULES: readonly DueRule[] = ["bill", "next_month_day", "fixed_day"];
export const AMOUNT_MODES = ["fixed", "variable"] as const;
export type AmountMode = (typeof AMOUNT_MODES)[number];

export const BILL_GRACE_DAYS_KEY = "recurring_bill_grace_days";
export const DEFAULT_BILL_GRACE_DAYS = 30;

export interface PeriodSeries {
  id: string;
  cadence: RecurringCadence;
  startMonth: string;
  endMonth: string | null;
  paymentMethod: string | null;
  dueRule: string;
  dueDay: number | null;
  amountMode: string;
  amountCents: number | null;
  requireProof: boolean;
  remindDays: number;
  needsDocument?: boolean;
  matchRule: string | null;
  /** 項目供應商(主檔)的統編;match_rule.vendorTaxId 優先。 */
  vendorTaxId?: string | null;
}

export interface PeriodRef {
  periodKey: string;
  months: string[];
  /** cadence 的應有月份(V1.01 月份檢核的那一格)。 */
  expectedMonth: string;
}

/** cadence 的應有月份 → 這一期涵蓋的月份。雙月 = [應有月-1, 應有月]。 */
export function periodMonthsFor(cadence: RecurringCadence, expectedMonth: string): string[] {
  return cadence === "bimonthly_odd" || cadence === "bimonthly_even" ? [addMonths(expectedMonth, -1), expectedMonth] : [expectedMonth];
}

function monthNo(m: string): number {
  return Number(m.slice(5, 7));
}

/** 任一月份 → 它所屬的期次。 */
export function periodForMonth(series: Pick<PeriodSeries, "cadence" | "startMonth">, month: string): PeriodRef {
  let expected = month;
  if (series.cadence === "bimonthly_even") expected = monthNo(month) % 2 === 0 ? month : addMonths(month, 1);
  else if (series.cadence === "bimonthly_odd") expected = monthNo(month) % 2 === 1 ? month : addMonths(month, 1);
  else if (series.cadence === "yearly") expected = `${month.slice(0, 4)}-${series.startMonth.slice(5, 7)}`;
  const months = periodMonthsFor(series.cadence, expected);
  return { periodKey: months[0], months, expectedMonth: expected };
}

/** [from, to] 之間的期次(以應有月份落在區間內計)。 */
export function expectedPeriods(series: Pick<PeriodSeries, "cadence" | "startMonth" | "endMonth">, from: string, to: string): PeriodRef[] {
  return expectedMonths(series, from, to).map((e) => {
    const months = periodMonthsFor(series.cadence, e);
    return { periodKey: months[0], months, expectedMonth: e };
  });
}

function lastDayOf(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = monthNo(month);
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(d).padStart(2, "0")}`;
}

function dayIn(month: string, day: number): string {
  const last = Number(lastDayOf(month).slice(8, 10));
  return `${month}-${String(Math.min(Math.max(1, day), last)).padStart(2, "0")}`;
}

/** 預估繳費期限:有帳單上的期限就用;否則 fixed_day = 期末月 N 日;bill/next_month_day = 期末次月 N 日(N 預設 15)。 */
export function estimateDueDate(series: Pick<PeriodSeries, "dueRule" | "dueDay">, months: string[], billDueDate?: string | null): { dueDate: string; source: "bill" | "estimated" } {
  if (billDueDate && /^\d{4}-\d{2}-\d{2}$/.test(billDueDate)) return { dueDate: billDueDate, source: "bill" };
  const last = months[months.length - 1];
  const day = series.dueDay ?? 15;
  if (series.dueRule === "fixed_day") return { dueDate: dayIn(last, day), source: "estimated" };
  return { dueDate: dayIn(addMonths(last, 1), day), source: "estimated" };
}

/** 預期帳單日 = 期末月最後一天(帳單通常在期末寄)。 */
export function expectedBillDate(months: string[]): string {
  return lastDayOf(months[months.length - 1]);
}

const DAY = 86400000;
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / DAY);
}
function todayTaipei(now: Date): string {
  return new Date(now.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 畫面狀態(第四節)
// ---------------------------------------------------------------------------
export type PeriodDisplayStatus =
  | "paid"
  | "waived"
  | "debited" // 已扣款、缺證明(還在寬限內)
  | "proof_missing" // 缺繳款證明(已過繳費日 + 寬限)
  | "pending_statement" // 待對帳:自動扣款已過繳費日,但涵蓋的對帳單還沒匯入
  | "bill_missing" // 帳單未到:預期帳單日 + 寬限仍無帳單也無扣款
  | "overdue" // 逾期未繳
  | "due_soon"
  | "not_due";

export const PERIOD_DISPLAY_LABELS: Record<PeriodDisplayStatus, string> = {
  paid: "已繳",
  waived: "無需帳單",
  debited: "已扣款、缺證明",
  proof_missing: "缺繳款證明",
  pending_statement: "待對帳",
  bill_missing: "帳單未到",
  overdue: "逾期未繳",
  due_soon: "即將繳費",
  not_due: "未到期",
};

export interface PeriodState {
  months: string[];
  status: PeriodStatus;
  dueDate: string | null;
  billDocId: string | null;
  statementLineId: number | null;
}

export function isAutoPay(paymentMethod: string | null | undefined): boolean {
  return paymentMethod === "auto_debit" || paymentMethod === "credit_card";
}

/** statementCoveredThrough:已匯入的對帳單涵蓋到哪一天(statement_lines 最大日期);沒有對帳單就是 null。 */
export function periodDisplayStatus(
  period: PeriodState,
  series: Pick<PeriodSeries, "paymentMethod" | "remindDays" | "needsDocument">,
  now: Date,
  ctx: { statementCoveredThrough: string | null; graceDays?: number },
): PeriodDisplayStatus {
  const grace = ctx.graceDays ?? DEFAULT_BILL_GRACE_DAYS;
  const today = todayTaipei(now);
  if (period.status === "paid") return "paid";
  if (period.status === "waived") return "waived";
  const due = period.dueDate;
  if (period.status === "debited") return due && daysBetween(due, today) > grace ? "proof_missing" : "debited";
  const noBill = !period.billDocId && !period.statementLineId;
  if (noBill && series.needsDocument !== false && daysBetween(expectedBillDate(period.months), today) > grace) return "bill_missing";
  if (due && today > due) {
    if (isAutoPay(series.paymentMethod) && (!ctx.statementCoveredThrough || ctx.statementCoveredThrough < due)) return "pending_statement";
    return "overdue";
  }
  if (due && daysBetween(today, due) <= series.remindDays) return "due_soon";
  return "not_due";
}

/** 通知鈴只推這四類(加上待覆核掛期,由 API 另外推)。 */
export const NOTIFY_DISPLAY_STATUSES: readonly PeriodDisplayStatus[] = ["overdue", "bill_missing", "proof_missing"];

// ---------------------------------------------------------------------------
// 文件 → 項目/期次(3.1)
// ---------------------------------------------------------------------------
export type DocumentRole = "bill" | "proof" | "bill_and_proof";
export const DOCUMENT_ROLE_FIELD_KEY = "document_role";

/** 文件角色:擷取欄位 document_role 優先;否則看類型(收據/繳費證明 → proof,其餘 → bill)。 */
export function documentRoleOf(input: { documentRole?: string | null; financeDocType?: string | null; fileTypeLabel?: string | null; texts?: string[] }): DocumentRole {
  const r = input.documentRole?.trim();
  if (r === "bill" || r === "proof" || r === "bill_and_proof") return r;
  const text = (input.texts ?? []).join(" ");
  const isProof = input.financeDocType === "RCT" || input.fileTypeLabel === "收據" || /繳費證明|繳款證明|收據|已扣款|扣款成功|代繳.*證明/.test(text);
  const isBill = /繳費通知|繳款單|帳單|繳費單/.test(text);
  if (isProof && isBill && /代收|超商/.test(text)) return "bill_and_proof";
  return isProof ? "proof" : "bill";
}

function normRef(v: string): string {
  return v.replace(/[\s-]/g, "").toUpperCase();
}

export interface DocSeriesInput {
  vendorTaxId: string | null;
  /** 統編是否已建檔(任務 1:未建檔不自動掛期,進待覆核)。 */
  vendorRegistered: boolean;
  /** 擷取欄位值、顯示名稱、OCR 店名等,用來找用戶號碼。 */
  texts: string[];
}

export type DocSeriesMatch =
  | { kind: "auto"; seriesId: string; confidence: "high"; reason: string }
  | { kind: "review"; seriesId: string; confidence: "medium"; reason: "medium_confidence" | "vendor_unregistered"; note: string }
  | { kind: "none" };

/** 找項目:統編 = 項目統編 且 用戶號碼 ∈ accountRefs → 高信心;只中統編、該統編只有一個項目 → 中信心;其他不掛。
 * 統編未建檔(主檔沒有)→ 一律待覆核。 */
export function matchDocumentSeries(doc: DocSeriesInput, series: PeriodSeries[]): DocSeriesMatch {
  const tax = doc.vendorTaxId ? normalizeTaxId(doc.vendorTaxId) : null;
  if (!tax) return { kind: "none" };
  const cands = series.filter((s) => {
    const rule = parseMatchRuleV2(s.matchRule);
    const t = rule.vendorTaxId ?? s.vendorTaxId ?? null;
    return t && normalizeTaxId(t) === tax;
  });
  if (!cands.length) return { kind: "none" };
  const texts = doc.texts.map(normRef);
  const refHits = cands.filter((s) => parseMatchRuleV2(s.matchRule).accountRefs.some((ref) => texts.some((t) => t.includes(normRef(ref)))));
  let picked: { s: PeriodSeries; high: boolean; reason: string } | null = null;
  if (refHits.length === 1) picked = { s: refHits[0], high: true, reason: `統編 ${tax} + 用戶號碼相符` };
  else if (refHits.length === 0 && cands.length === 1) picked = { s: cands[0], high: false, reason: `只對到統編 ${tax}(這個統編只有一個項目)` };
  if (!picked) return { kind: "none" };
  if (!doc.vendorRegistered) {
    return { kind: "review", seriesId: picked.s.id, confidence: "medium", reason: "vendor_unregistered", note: `${picked.reason};但統編 ${tax} 未建檔,不自動掛期` };
  }
  if (picked.high) return { kind: "auto", seriesId: picked.s.id, confidence: "high", reason: picked.reason };
  return { kind: "review", seriesId: picked.s.id, confidence: "medium", reason: "medium_confidence", note: picked.reason };
}

/** 文件決定期次:帳單月份(billing_month,可多個)優先;沒有就用單據日期依 cadence 推。 */
export function periodForDocument(series: Pick<PeriodSeries, "cadence" | "startMonth">, input: { billingMonths: string[]; docDate: string | null }): PeriodRef | null {
  const months = input.billingMonths.filter(isValidMonth).sort();
  const m = months.length ? months[months.length - 1] : input.docDate?.slice(0, 7);
  return m && isValidMonth(m) ? periodForMonth(series, m) : null;
}

export interface PeriodRow {
  billDocId: string | null;
  proofDocId: string | null;
  statementLineId: number | null;
  status: PeriodStatus;
  amountCents: number | null;
  dueDate: string | null;
  dueDateSource: string;
}

export interface PeriodPatch {
  billDocId?: string;
  proofDocId?: string;
  amountCents?: number | null;
  dueDate?: string;
  dueDateSource?: "bill";
  status?: PeriodStatus;
  paidAt?: string | null;
  paidSource?: PaidSource;
  billMissingFlag?: boolean;
}

/** 文件掛上期次:同一期已有不同的帳單/證明 → 不覆蓋,回 conflict(進待覆核)。 */
export function applyDocumentToPeriod(
  period: PeriodRow | null,
  role: DocumentRole,
  doc: { id: string; amountCents: number | null; billDueDate: string | null; date: string | null },
): { patch: PeriodPatch; conflict: null | "duplicate_bill" | "duplicate_proof" } {
  const wantsBill = role === "bill" || role === "bill_and_proof";
  const wantsProof = role === "proof" || role === "bill_and_proof";
  if (wantsBill && period?.billDocId && period.billDocId !== doc.id) return { patch: {}, conflict: "duplicate_bill" };
  if (wantsProof && period?.proofDocId && period.proofDocId !== doc.id) return { patch: {}, conflict: "duplicate_proof" };
  const patch: PeriodPatch = {};
  const current = period?.status ?? "expected";
  if (wantsBill) {
    patch.billDocId = doc.id;
    if (doc.amountCents != null) patch.amountCents = doc.amountCents;
    if (doc.billDueDate) {
      patch.dueDate = doc.billDueDate;
      patch.dueDateSource = "bill";
    }
    patch.billMissingFlag = false;
    if (current === "expected" || current === "overdue") patch.status = "billed";
  }
  if (wantsProof) {
    patch.proofDocId = doc.id;
    patch.status = "paid";
    patch.paidSource = "proof";
    patch.paidAt = doc.date ?? null;
    if (!wantsBill && period?.amountCents == null && doc.amountCents != null) patch.amountCents = doc.amountCents;
  }
  return { patch, conflict: null };
}

// ---------------------------------------------------------------------------
// 對帳單扣款 → 期次(3.2)
// ---------------------------------------------------------------------------
export interface StatementLineInput {
  id: number;
  date: string;
  amountCents: number;
  description: string;
}

export interface SeriesPeriodsInput {
  series: PeriodSeries;
  periods: Array<PeriodRow & { periodKey: string; months: string[] }>;
}

export type StatementMatch =
  | { kind: "none" }
  | { kind: "review"; reason: "multiple_matches" | "amount_mismatch"; seriesId: string | null; periodKey: string | null; note: string }
  | {
      kind: "match";
      seriesId: string;
      periodKey: string;
      months: string[];
      create: boolean;
      status: "paid" | "debited";
      billMissing: boolean;
      amountCents: number;
      note: string;
    };

/** 摘要含關鍵字 + 自動扣款/信用卡代繳 + 金額(±容許差)+ 日期(期限 ±窗)唯一命中 → 掛上。
 * 帳單還沒到但扣款先到 → 建立/補上期次,標帳單未到。require_proof 項目只到 debited。 */
export function matchStatementDebit(line: StatementLineInput, all: SeriesPeriodsInput[]): StatementMatch {
  const desc = line.description;
  const cands = all.filter((x) => isAutoPay(x.series.paymentMethod) && parseMatchRuleV2(x.series.matchRule).statementKeywords.some((k) => desc.includes(k)));
  if (!cands.length) return { kind: "none" };
  const amount = Math.abs(line.amountCents);
  const hits: Array<{ x: SeriesPeriodsInput; periodKey: string; months: string[]; create: boolean; billMissing: boolean }> = [];
  const nearMisses: string[] = [];
  for (const x of cands) {
    const rule = parseMatchRuleV2(x.series.matchRule);
    const inWindow = (due: string | null) => !!due && Math.abs(daysBetween(due, line.date)) <= rule.dateWindowDays;
    const amountOk = (cents: number | null) => cents != null && Math.abs(cents - amount) <= rule.amountTolerance;
    // 已有帳單(或 fixed 項目的預期金額)的未付期次
    for (const p of x.periods) {
      if (p.status === "paid" || p.status === "waived" || p.statementLineId) continue;
      if (!inWindow(p.dueDate)) continue;
      const target = p.amountCents ?? (x.series.amountMode === "fixed" ? x.series.amountCents : null);
      if (amountOk(target)) hits.push({ x, periodKey: p.periodKey, months: p.months, create: false, billMissing: !p.billDocId });
      else if (target != null) nearMisses.push(`${x.series.id} ${p.periodKey} 帳單 ${target} ≠ 扣款 ${amount}`);
    }
    // 帳單還沒到:找一個「預估期限落在窗內、還沒有帳單/扣款」的期次(或還沒建立的期次)
    if (!hits.some((h) => h.x === x)) {
      const around = [-2, -1, 0, 1].map((d) => periodForMonth(x.series, addMonths(line.date.slice(0, 7), d)));
      for (const ref of around) {
        const existing = x.periods.find((p) => p.periodKey === ref.periodKey);
        if (existing && (existing.billDocId || existing.statementLineId || existing.status === "paid" || existing.status === "waived")) continue;
        const due = existing?.dueDate ?? estimateDueDate(x.series, ref.months).dueDate;
        if (!inWindow(due)) continue;
        if (x.series.amountMode === "fixed" && x.series.amountCents != null && !amountOk(x.series.amountCents)) {
          nearMisses.push(`${x.series.id} ${ref.periodKey} 固定金額 ${x.series.amountCents} ≠ 扣款 ${amount}`);
          continue;
        }
        if (!hits.some((h) => h.x === x && h.periodKey === ref.periodKey)) hits.push({ x, periodKey: ref.periodKey, months: ref.months, create: !existing, billMissing: true });
      }
    }
  }
  const uniq = [...new Map(hits.map((h) => [`${h.x.series.id}|${h.periodKey}`, h])).values()];
  if (uniq.length === 1) {
    const h = uniq[0];
    return {
      kind: "match",
      seriesId: h.x.series.id,
      periodKey: h.periodKey,
      months: h.months,
      create: h.create,
      status: h.x.series.requireProof ? "debited" : "paid",
      billMissing: h.billMissing,
      amountCents: amount,
      note: `對帳單 ${line.date} ${desc} ${amount}${h.billMissing ? "(帳單未到)" : ""}`,
    };
  }
  if (uniq.length > 1) {
    return { kind: "review", reason: "multiple_matches", seriesId: null, periodKey: null, note: `多筆命中:${uniq.map((h) => `${h.x.series.id} ${h.periodKey}`).join("、")}` };
  }
  if (nearMisses.length) return { kind: "review", reason: "amount_mismatch", seriesId: cands[0].series.id, periodKey: null, note: nearMisses.join(";") };
  return { kind: "none" };
}
