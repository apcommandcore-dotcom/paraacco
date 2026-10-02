// 定期帳單月份檢核(2026-09-28,CODE_TASK_local-originals-nas-path_20260927_V1.01.md 第二節 3、
// 第三節 6)——純函式,API(routes/recurring.ts)與測試共用。資料表見 packages/db schema 的
// recurring_series / recurring_month_marks;月份與文件的對應存在 document_extracted_fields
// (fieldKey 'billing_month'、'billing_month_2'…,值 YYYY-MM;'recurring_series_id')。

import { advanceDueDate, computeWarrantyStatus, type RenewalCycle } from "./warranty-status";

export type RecurringCadence = "monthly" | "bimonthly_odd" | "bimonthly_even" | "yearly";
export const RECURRING_CADENCES: readonly RecurringCadence[] = ["monthly", "bimonthly_odd", "bimonthly_even", "yearly"];

/** 有:有帳單/繳款單;只有催繳:該月只有催繳/滯納/行政執行類文件;加密:只有讀不到的加密原檔;
 * 無需帳單:人工標記(例如信用卡當月無消費);缺:以上皆非。 */
export type CoverageStatus = "present" | "reminder_only" | "encrypted" | "not_required" | "missing";

export const COVERAGE_STATUS_LABELS: Record<CoverageStatus, string> = {
  present: "有",
  reminder_only: "只有催繳",
  encrypted: "加密",
  not_required: "無需帳單",
  missing: "缺",
};

export const BILLING_MONTH_FIELD_KEY = "billing_month";
export const RECURRING_SERIES_FIELD_KEY = "recurring_series_id";
/** 雙月/合併帳單會對應多個月份:第一個月存 billing_month,其後依序 billing_month_2、_3…
 * (document_extracted_fields 有 (documentId, fieldKey) UNIQUE,同一個 fieldKey 只能一列)。 */
export const MAX_BILLING_MONTHS_PER_DOCUMENT = 12;

export function billingMonthFieldKey(index: number): string {
  return index === 0 ? BILLING_MONTH_FIELD_KEY : `${BILLING_MONTH_FIELD_KEY}_${index + 1}`;
}

export function isBillingMonthFieldKey(fieldKey: string): boolean {
  return fieldKey === BILLING_MONTH_FIELD_KEY || /^billing_month_\d+$/.test(fieldKey);
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isValidMonth(m: unknown): m is string {
  return typeof m === "string" && MONTH_RE.test(m);
}

function toIndex(m: string): number {
  const [, y, mo] = MONTH_RE.exec(m) ?? [];
  if (!y) throw new Error(`月份格式錯誤:${m}(應為 YYYY-MM)`);
  return Number(y) * 12 + Number(mo) - 1;
}

function fromIndex(i: number): string {
  return `${String(Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`;
}

export function addMonths(m: string, n: number): string {
  return fromIndex(toIndex(m) + n);
}

/** 今天所在月份的前一個月(「仍在繳」的 series 檢核到這裡,當月帳單通常還沒到)。 */
export function lastCompleteMonth(now: Date = new Date()): string {
  // 以台北時間判斷月份。
  const taipei = new Date(now.getTime() + 8 * 3600 * 1000);
  return addMonths(fromIndex(taipei.getUTCFullYear() * 12 + taipei.getUTCMonth()), -1);
}

/** series 在 [from, to] 區間內「應該有帳單」的月份。 */
export function expectedMonths(
  series: { cadence: RecurringCadence; startMonth: string; endMonth: string | null },
  from: string,
  to: string,
): string[] {
  const start = Math.max(toIndex(series.startMonth), toIndex(from));
  const end = Math.min(series.endMonth ? toIndex(series.endMonth) : Number.POSITIVE_INFINITY, toIndex(to));
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    const month = (i % 12) + 1;
    const ok =
      series.cadence === "monthly" ||
      (series.cadence === "bimonthly_odd" && month % 2 === 1) ||
      (series.cadence === "bimonthly_even" && month % 2 === 0) ||
      (series.cadence === "yearly" && month === (toIndex(series.startMonth) % 12) + 1);
    if (ok) out.push(fromIndex(i));
  }
  return out;
}

export interface CoverageDocRef {
  documentId: string;
  /** 催繳/滯納/行政執行類(document_case_links.role 為 reminder/penalty/enforcement)。 */
  isReminder: boolean;
}

export interface CoverageMark {
  month: string;
  status: "not_required" | "encrypted";
  note: string | null;
}

export interface CoverageCell {
  month: string;
  status: CoverageStatus;
  /** 是否在 cadence 的應有月份內(不在的月份只有「剛好有文件」時才會列出)。 */
  expected: boolean;
  documentIds: string[];
  reminderDocumentIds: string[];
  note: string | null;
}

export interface CoverageSummary {
  expected: number;
  present: number;
  reminderOnly: number;
  encrypted: number;
  notRequired: number;
  missing: number;
}

export function computeCoverage(
  series: { cadence: RecurringCadence; startMonth: string; endMonth: string | null },
  from: string,
  to: string,
  docsByMonth: Map<string, CoverageDocRef[]>,
  marks: CoverageMark[],
): { months: CoverageCell[]; summary: CoverageSummary } {
  const expected = new Set(expectedMonths(series, from, to));
  const fromI = toIndex(from);
  const toI = toIndex(to);
  const monthsWithDocs = [...docsByMonth.keys()].filter((m) => isValidMonth(m) && toIndex(m) >= fromI && toIndex(m) <= toI);
  const markByMonth = new Map(marks.map((m) => [m.month, m]));
  const all = [...new Set([...expected, ...monthsWithDocs])].sort();

  const summary: CoverageSummary = { expected: expected.size, present: 0, reminderOnly: 0, encrypted: 0, notRequired: 0, missing: 0 };
  const months = all.map((month): CoverageCell => {
    const docs = docsByMonth.get(month) ?? [];
    const bills = docs.filter((d) => !d.isReminder).map((d) => d.documentId);
    const reminders = docs.filter((d) => d.isReminder).map((d) => d.documentId);
    const mark = markByMonth.get(month);
    let status: CoverageStatus;
    if (bills.length) status = "present";
    else if (reminders.length) status = "reminder_only";
    else if (mark) status = mark.status;
    else status = "missing";
    if (expected.has(month)) {
      if (status === "present") summary.present++;
      else if (status === "reminder_only") summary.reminderOnly++;
      else if (status === "encrypted") summary.encrypted++;
      else if (status === "not_required") summary.notRequired++;
      else summary.missing++;
    }
    return { month, status, expected: expected.has(month), documentIds: bills, reminderDocumentIds: reminders, note: mark?.note ?? null };
  });
  return { months, summary };
}

// ---------------------------------------------------------------------------
// 系統建議(覆核頁用):依 match_rule 猜 series、依擷取欄位猜月份。只是建議,人工確認後才寫入。
// ---------------------------------------------------------------------------

export interface RecurringMatchRule {
  vendorTaxId?: string;
  vendorNameKeywords?: string[];
  accountRef?: string;
}

export function parseMatchRule(raw: string | null): RecurringMatchRule {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as RecurringMatchRule) : {};
  } catch {
    return {};
  }
}

export interface SeriesSuggestionInput {
  vendorTaxId: string | null;
  vendorNameRaw: string | null;
  /** 其餘擷取欄位值、顯示名稱等,用來找用戶號碼/卡號末四碼。 */
  texts: string[];
}

export function scoreSeriesMatch(rule: RecurringMatchRule, doc: SeriesSuggestionInput): number {
  let score = 0;
  if (rule.vendorTaxId && doc.vendorTaxId && rule.vendorTaxId === doc.vendorTaxId) score += 60;
  const name = doc.vendorNameRaw ?? "";
  if (rule.vendorNameKeywords?.some((k) => k && name.includes(k))) score += 30;
  if (rule.accountRef && doc.texts.some((t) => t.includes(rule.accountRef!))) score += 40;
  return score;
}

export function suggestSeries<T extends { id: string; matchRule: string | null }>(
  series: T[],
  doc: SeriesSuggestionInput,
): { seriesId: string; score: number } | null {
  let best: { seriesId: string; score: number } | null = null;
  for (const s of series) {
    const score = scoreSeriesMatch(parseMatchRule(s.matchRule), doc);
    if (score >= 30 && (!best || score > best.score)) best = { seriesId: s.id, score };
  }
  return best;
}

/** 從發票期別/單據日期猜帳單月份。發票期別 'YYYY-MM' 直接用;'YYYY-MM~YYYY-MM' 展開;民國年 'NNN/MM' 換算;
 * 都沒有就用單據日期所在月份。 */
export function suggestBillingMonths(input: { invoicePeriod?: string | null; invoiceDate?: string | null; docDate?: string | null }): string[] {
  const p = (input.invoicePeriod ?? "").trim();
  const range = /^(\d{4}-\d{2})\s*[~～至-]\s*(\d{4}-\d{2})$/.exec(p);
  if (range && isValidMonth(range[1]) && isValidMonth(range[2]) && toIndex(range[2]) >= toIndex(range[1]) && toIndex(range[2]) - toIndex(range[1]) < MAX_BILLING_MONTHS_PER_DOCUMENT) {
    const out: string[] = [];
    for (let i = toIndex(range[1]); i <= toIndex(range[2]); i++) out.push(fromIndex(i));
    return out;
  }
  if (isValidMonth(p)) return [p];
  const roc = /^(\d{2,3})\s*[/年-]\s*(\d{1,2})/.exec(p);
  if (roc) {
    const m = `${Number(roc[1]) + 1911}-${roc[2].padStart(2, "0")}`;
    if (isValidMonth(m)) return [m];
  }
  for (const d of [input.invoiceDate, input.docDate]) {
    const m = d?.slice(0, 7);
    if (isValidMonth(m)) return [m];
  }
  return [];
}

// ---------------------------------------------------------------------------
// 2026-09-29 定期繳費單一頁(CODE_TASK_recurring-bills-single-page_20260929_V1.01.md)——recurring_series 成為
// 定期繳費主表,提醒欄位(分類/本期金額/繳費方式/下期繳費日/提醒天數)從 warranty_subscriptions 併過來。
// 訂閱(例 Claude Pro)不算定期繳費,留在 warranty_subscriptions(「保固與訂閱」頁)。
// ---------------------------------------------------------------------------

/** 定期繳費分類(頁面分頁/篩選)。沿用 WARRANTY_CATEGORIES 中屬於定期繳費的類別,另加 statement(信用卡/銀行對帳單,
 * 既有 RCS-010~019 用)。DB 不加 CHECK,只在 API 驗證。 */
export const RECURRING_CATEGORIES = [
  "water",
  "electricity",
  "gas",
  "internet",
  "telecom",
  "labor_insurance",
  "health_insurance",
  "pension",
  "tax",
  "insurance",
  "rent",
  "membership",
  "statement",
  "other",
] as const;
export type RecurringCategory = (typeof RECURRING_CATEGORIES)[number];

export const RECURRING_CATEGORY_LABELS: Record<RecurringCategory, string> = {
  water: "水費",
  electricity: "電費",
  gas: "瓦斯",
  internet: "網路",
  telecom: "電信",
  labor_insurance: "勞保",
  health_insurance: "健保",
  pension: "勞退",
  tax: "稅金",
  insurance: "保險",
  rent: "租金",
  membership: "會費",
  statement: "信用卡/對帳單",
  other: "其他",
};

/** cadence → 「已繳,排下一期」用的週期(沿用 warranty 的 advanceDueDate,月底日對齊行為一致)。 */
export function cadenceRenewalCycle(cadence: RecurringCadence): Exclude<RenewalCycle, "one_time" | "quarterly" | "semiannual"> {
  if (cadence === "monthly") return "monthly";
  if (cadence === "yearly") return "yearly";
  return "bimonthly";
}

export function advanceSeriesDueDate(nextDueDate: string, cadence: RecurringCadence): string {
  return advanceDueDate(nextDueDate, cadenceRenewalCycle(cadence))!;
}

/** 下期繳費狀態:逾期未繳 / 即將繳費 / 未到期;沒設下期繳費日的是 unscheduled。 */
export type RecurringDueStatus = "overdue" | "due_soon" | "not_due" | "unscheduled";

export const RECURRING_DUE_STATUS_LABELS: Record<RecurringDueStatus, string> = {
  overdue: "逾期未繳",
  due_soon: "即將繳費",
  not_due: "未到期",
  unscheduled: "—",
};

export function recurringDueStatus(nextDueDate: string | null, remindDays: number, now: Date = new Date()): RecurringDueStatus {
  if (!nextDueDate) return "unscheduled";
  const s = computeWarrantyStatus({ endDate: nextDueDate, reminderDaysBefore: remindDays }, now);
  return s === "expired" ? "overdue" : s === "due_soon" ? "due_soon" : "not_due";
}

/** needs_document=0 的 series(例:勞退每月扣款、沒有帳單文件):應有月份沒有文件也沒有人工標記的,
 * 視為「無需帳單」,不算缺。有人工標記的照人工標記。 */
export function autoNotRequiredMarks(
  series: { cadence: RecurringCadence; startMonth: string; endMonth: string | null },
  from: string,
  to: string,
  docsByMonth: Map<string, CoverageDocRef[]>,
  marks: CoverageMark[],
): CoverageMark[] {
  const marked = new Set(marks.map((m) => m.month));
  const extra = expectedMonths(series, from, to)
    .filter((m) => !marked.has(m) && !(docsByMonth.get(m)?.length))
    .map((month) => ({ month, status: "not_required" as const, note: "此項目設定為無需帳單" }));
  return [...marks, ...extra];
}

// ---------------------------------------------------------------------------
// 2026-10-01(V1.04 第〇之一節):/browse「依標題瀏覽」完全不出現定期繳費的分類、供應商、文件。
// categories 表裡這三個是定期繳費分類(舊網址 /browse?category=… 301 到 /recurring 對應分類);
// 名稱比對是保險(之後在後台新增「水費」之類的分類也一併排除)。
// ---------------------------------------------------------------------------
export const RECURRING_BROWSE_CATEGORY_MAP: Record<string, string[]> = {
  telecom: ["telecom", "internet"],
  insurance: ["labor_insurance", "health_insurance", "pension"],
  utilities: ["water", "electricity", "gas"],
};

const RECURRING_CATEGORY_NAME_RE = /水費|電費|瓦斯|網路|電信|勞保|健保|勞退|勞健保|稅金|保險|租金|會費|水電/;

export function isRecurringBrowseCategory(c: { id: string; name: string }): boolean {
  return c.id in RECURRING_BROWSE_CATEGORY_MAP || RECURRING_CATEGORY_NAME_RE.test(c.name);
}
