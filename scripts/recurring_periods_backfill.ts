// paraacco 定期繳費期次回溯 recurring_periods_backfill.ts V1.0(2026-10-01)
// CODE_TASK_recurring-bills-single-page_20260929_V1.04.md 第六節:只產生 dry-run 清單與 SQL,不連 D1、不寫入。
//   1. 每個 series 從 start_month 到本月的下一期產生期次(雙月一期兩個月)。
//   2. 已掛 recurring_series_id 的文件(V1.01 的 370 個帳單月份)直接轉成期次的帳單/證明,不重新判斷;
//      同一期多份文件時,第一份(非催繳、DOC 號小)掛上,其餘列 review(重複/催繳)。
//   3. 未掛的文件用 matchDocumentSeries()(統編 + 用戶號碼)dry-run:高信心寫進 SQL,中信心/統編未建檔列 review。
//      對帳單明細(statement_lines)用 matchStatementDebit() dry-run。
//   4. 輸出:recurring-periods-backfill_<時間>.tsv、..._review.tsv、..._<時間>.sql、寫入列數估計。
// 規則與 API 共用 @paraacco/domain(recurring-periods.ts)。
//
// 輸入:一個 SQLite 檔(正式 D1 唯讀匯出 + migration 0010–0012 + 搬移 SQL 的本機模擬,見報告),不是正式 D1。
// 執行:node <repo>/node_modules/.pnpm/tsx@4.23.13/node_modules/tsx/dist/cli.mjs scripts/recurring_periods_backfill.ts <sim.sqlite> [YYYY-MM-DD 今天]
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  addMonths,
  applyDocumentToPeriod,
  documentRoleOf,
  estimateDueDate,
  expectedPeriods,
  isBillingMonthFieldKey,
  isValidMonth,
  matchDocumentSeries,
  matchStatementDebit,
  periodDisplayStatus,
  periodForDocument,
  periodForMonth,
  resolveVendorTaxId,
  PERIOD_DISPLAY_LABELS,
  type DocumentRole,
  type PeriodRow,
  type PeriodSeries,
  type RecurringCadence,
} from "../packages/domain/src/index";

const VERSION = "V1.0";
const OUT = process.env.OUT ?? join(homedir(), "dev/_reports/paraacco/recurring-seed");
const [dbPath, todayArg] = process.argv.slice(2);
if (!dbPath) {
  console.error("用法:recurring_periods_backfill.ts <sim.sqlite> [YYYY-MM-DD]");
  process.exit(2);
}
const now = todayArg ? new Date(`${todayArg}T04:00:00Z`) : new Date();
const thisMonth = new Date(now.getTime() + 8 * 3600e3).toISOString().slice(0, 7);
const db = new DatabaseSync(dbPath, { readOnly: true });
type R = Record<string, any>;
const all = (q: string) => db.prepare(q).all() as R[];

const seriesRows = all(`SELECT s.*, v.tax_id AS vendor_tax_id FROM recurring_series s LEFT JOIN vendors v ON v.id = s.vendor_id ORDER BY s.id`);
const series: PeriodSeries[] = seriesRows.map((s) => ({
  id: s.id,
  cadence: s.cadence as RecurringCadence,
  startMonth: s.start_month,
  endMonth: s.end_month,
  paymentMethod: s.payment_method,
  dueRule: s.due_rule ?? "bill",
  dueDay: s.due_day,
  amountMode: s.amount_mode ?? "variable",
  amountCents: s.amount_cents,
  requireProof: !!s.require_proof,
  remindDays: s.remind_days ?? 7,
  needsDocument: s.needs_document !== 0,
  matchRule: s.match_rule,
  vendorTaxId: s.vendor_tax_id,
}));
const seriesName = new Map(seriesRows.map((s) => [s.id, s.name as string]));
const docs = all(`SELECT d.*, f.local_path FROM documents d LEFT JOIN document_files f ON f.document_id = d.id AND f.kind = 'original' AND f.is_current = 1`);
const fields = all(`SELECT document_id, field_key, value FROM document_extracted_fields`);
const fieldsByDoc = new Map<string, Map<string, string>>();
for (const f of fields) {
  const m = fieldsByDoc.get(f.document_id) ?? new Map<string, string>();
  m.set(f.field_key, f.value);
  fieldsByDoc.set(f.document_id, m);
}
const reminders = new Set(all(`SELECT DISTINCT document_id FROM document_case_links WHERE role IN ('reminder','penalty','enforcement')`).map((r) => r.document_id));
const registeredTax = new Set(all(`SELECT tax_id FROM vendors WHERE tax_id IS NOT NULL`).map((r) => r.tax_id));
const lines = all(`SELECT * FROM statement_lines`);
const coveredThrough = (all(`SELECT MAX(date) d FROM statement_lines`)[0]?.d as string | null) ?? null;

type P = PeriodRow & { seriesId: string; periodKey: string; months: string[]; confidence: string; basis: string; created: boolean };
const periods = new Map<string, P>(); // `${seriesId}|${key}`
const review: string[][] = [];
const newDocFields: Array<{ docId: string; seriesId: string; month: string }> = [];
const key = (s: string, k: string) => `${s}|${k}`;

function ensure(s: PeriodSeries, ref: { periodKey: string; months: string[] }, basis = "產生期次"): P {
  const k = key(s.id, ref.periodKey);
  let p = periods.get(k);
  if (!p) {
    const due = estimateDueDate(s, ref.months);
    p = { seriesId: s.id, periodKey: ref.periodKey, months: ref.months, billDocId: null, proofDocId: null, statementLineId: null, status: "expected", amountCents: s.amountMode === "fixed" ? s.amountCents : null, dueDate: due.dueDate, dueDateSource: due.source, confidence: "", basis, created: true };
    periods.set(k, p);
  }
  return p;
}

// 1. 期次骨架
for (const s of series) {
  const to = addMonths(thisMonth, 2);
  for (const ref of expectedPeriods(s, s.startMonth, s.endMonth && s.endMonth < to ? s.endMonth : to)) ensure(s, ref);
}

function docInfo(d: R) {
  const f = fieldsByDoc.get(d.id) ?? new Map<string, string>();
  const tax = resolveVendorTaxId({ qr: f.get("vendorTaxIdQr"), printed: f.get("vendorTaxIdPrinted"), legacy: f.get("vendorTaxId"), legacySource: f.get("vendorTaxIdSource") }).taxId;
  const texts = [d.display_name, d.vendor_name_raw, ...f.values()].filter(Boolean) as string[];
  const fileType = (d.local_path ?? "").split("/").pop()?.split("_")[1] ?? null;
  return {
    f,
    tax,
    texts,
    role: documentRoleOf({ documentRole: f.get("document_role"), financeDocType: f.get("finance_doc_type"), fileTypeLabel: fileType, texts }) as DocumentRole,
    months: [...f.entries()].filter(([k, v]) => isBillingMonthFieldKey(k) && isValidMonth(v)).map(([, v]) => v).sort(),
    date: (d.invoice_date ?? d.doc_date) as string | null,
    billDue: d.doc_date && d.invoice_date && d.doc_date > d.invoice_date ? (d.doc_date as string) : null,
  };
}

function attach(s: PeriodSeries, ref: { periodKey: string; months: string[] }, d: R, role: DocumentRole, confidence: string, basis: string): boolean {
  const p = ensure(s, ref);
  const info = docInfo(d);
  const { patch, conflict } = applyDocumentToPeriod(p, role, { id: d.id, amountCents: d.amount_cents, billDueDate: info.billDue, date: info.date });
  if (conflict) {
    review.push([s.id, seriesName.get(s.id)!, ref.periodKey, d.id, role, conflict === "duplicate_bill" ? "同一期已有帳單" : "同一期已有證明", `已掛 ${conflict === "duplicate_bill" ? p.billDocId : p.proofDocId};${reminders.has(d.id) ? "這份是催繳/滯納類;" : ""}${basis}`]);
    return false;
  }
  Object.assign(p, patch);
  p.confidence = confidence;
  p.basis = basis;
  return true;
}

// 2. 已掛 series 的文件直接轉(非催繳優先、DOC 號小優先)
const linked = docs
  .filter((d) => !["ignored", "dup"].includes(d.status) && fieldsByDoc.get(d.id)?.get("recurring_series_id"))
  .sort((a, b) => Number(reminders.has(a.id)) - Number(reminders.has(b.id)) || a.id.localeCompare(b.id));
let linkedMonths = 0;
for (const d of linked) {
  const s = series.find((x) => x.id === fieldsByDoc.get(d.id)!.get("recurring_series_id"));
  if (!s) continue;
  const info = docInfo(d);
  const months = info.months.length ? info.months : [];
  linkedMonths += months.length;
  if (!months.length) {
    review.push([s.id, seriesName.get(s.id)!, "", d.id, info.role, "沒有帳單月份", "已掛定期帳單但沒有 billing_month,無法決定期次"]);
    continue;
  }
  const refs = [...new Map(months.map((m) => periodForMonth(s, m)).map((r) => [r.periodKey, r])).values()];
  for (const ref of refs) attach(s, ref, d, info.role, "backfill", `既有 recurring_series_id + billing_month ${months.join("、")}`);
}

// 3. 未掛的文件 dry-run
let unlinkedChecked = 0;
for (const d of docs) {
  if (["ignored", "dup", "failed"].includes(d.status) || fieldsByDoc.get(d.id)?.get("recurring_series_id")) continue;
  unlinkedChecked++;
  const info = docInfo(d);
  const m = matchDocumentSeries({ vendorTaxId: info.tax, vendorRegistered: !!d.vendor_id || (!!info.tax && registeredTax.has(info.tax)), texts: info.texts }, series);
  if (m.kind === "none") continue;
  const s = series.find((x) => x.id === m.seriesId)!;
  const ref = periodForDocument(s, { billingMonths: info.months, docDate: info.date });
  if (m.kind === "review") {
    review.push([s.id, seriesName.get(s.id)!, ref?.periodKey ?? "", d.id, info.role, m.reason === "vendor_unregistered" ? "統編未建檔" : "中信心", m.note]);
    continue;
  }
  if (!ref) {
    review.push([s.id, seriesName.get(s.id)!, "", d.id, info.role, "找不到期次", m.reason]);
    continue;
  }
  if (attach(s, ref, d, info.role, "high", m.reason)) newDocFields.push({ docId: d.id, seriesId: s.id, month: ref.months[ref.months.length - 1] });
}

// 對帳單明細
for (const l of lines) {
  const input = series.map((s) => ({ series: s, periods: [...periods.values()].filter((p) => p.seriesId === s.id) }));
  const m = matchStatementDebit({ id: l.id, date: l.post_date ?? l.date, amountCents: l.amount_cents, description: l.description }, input);
  if (m.kind === "review") review.push([m.seriesId ?? "", m.seriesId ? seriesName.get(m.seriesId)! : "", m.periodKey ?? "", `line#${l.id}`, "debit", m.reason, m.note]);
  if (m.kind === "match") {
    const s = series.find((x) => x.id === m.seriesId)!;
    const p = ensure(s, { periodKey: m.periodKey, months: m.months });
    Object.assign(p, { statementLineId: l.id, status: p.status === "paid" ? "paid" : m.status, amountCents: p.amountCents ?? m.amountCents, confidence: "high", basis: m.note });
  }
}

// 3 筆截圖項目(水/電/瓦斯):2026-01 起沒有帳單也沒有扣款的期次列 review
const WATCH = ["RCS-001", "RCS-002", "RCS-003"];
const watchSummary: string[] = [];
for (const id of WATCH) {
  const ps = [...periods.values()].filter((p) => p.seriesId === id && p.months[p.months.length - 1] >= "2026-02" && p.months[p.months.length - 1] <= thisMonth);
  const missing = ps.filter((p) => !p.billDocId && !p.proofDocId && !p.statementLineId);
  for (const p of missing) review.push([id, seriesName.get(id)!, p.periodKey, "", "", "沒有帳單也沒有扣款", `期次 ${p.months.join("~")}`]);
  watchSummary.push(`${id} ${seriesName.get(id)}:2026-02 起 ${ps.length} 期,有帳單/扣款 ${ps.length - missing.length} 期,缺 ${missing.length} 期(${missing.map((p) => p.periodKey).join("、") || "—"})`);
}

// 輸出
const tag = new Date(now.getTime() + 8 * 3600e3).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
mkdirSync(OUT, { recursive: true });
const cell = (v: unknown) => String(v ?? "").replace(/[\t\n]/g, " ");
const sorted = [...periods.values()].sort((a, b) => a.seriesId.localeCompare(b.seriesId) || a.periodKey.localeCompare(b.periodKey));
const tsv = [["series", "名稱", "period_key", "期間", "繳費期限", "期限來源", "金額", "bill DOC", "proof DOC", "statement_line", "狀態", "畫面狀態(以今天計)", "信心", "依據"].join("\t")];
for (const p of sorted) {
  const s = series.find((x) => x.id === p.seriesId)!;
  const disp = periodDisplayStatus(p, s, now, { statementCoveredThrough: coveredThrough });
  tsv.push([p.seriesId, seriesName.get(p.seriesId), p.periodKey, p.months.join("~"), p.dueDate, p.dueDateSource, p.amountCents == null ? "" : p.amountCents / 100, p.billDocId, p.proofDocId, p.statementLineId, p.status, PERIOD_DISPLAY_LABELS[disp], p.confidence, p.basis].map(cell).join("\t"));
}
const tsvPath = join(OUT, `recurring-periods-backfill_${tag}.tsv`);
writeFileSync(tsvPath, tsv.join("\n") + "\n");
const reviewPath = join(OUT, `recurring-periods-backfill_${tag}_review.tsv`);
writeFileSync(reviewPath, [["series", "名稱", "period_key", "文件/明細", "角色", "原因", "說明"].join("\t"), ...review.map((r) => r.map(cell).join("\t"))].join("\n") + "\n");

const q = (v: unknown) => (v == null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const sql: string[] = [];
for (const p of sorted) {
  sql.push(
    `INSERT INTO recurring_periods (series_id, period_key, period_months, due_date, due_date_source, amount_cents, bill_doc_id, proof_doc_id, statement_line_id, status, paid_at, paid_source, bill_missing_flag, match_confidence, match_note) VALUES (${[
      p.seriesId,
      p.periodKey,
      JSON.stringify(p.months),
      p.dueDate,
      p.dueDateSource,
      p.amountCents,
      p.billDocId,
      p.proofDocId,
      p.statementLineId,
      p.status,
      (p as any).paidAt ?? null,
      (p as any).paidSource ?? null,
    ]
      .map(q)
      .join(", ")}, ${(p as any).billMissingFlag ? 1 : 0}, ${q(p.confidence || null)}, ${q(p.basis)}) ON CONFLICT(series_id, period_key) DO NOTHING;`,
  );
}
for (const f of newDocFields) {
  sql.push(
    `INSERT INTO document_extracted_fields (document_id, field_key, label, value, extraction_source, source_note, sort_order) VALUES (${q(f.docId)}, 'recurring_series_id', '定期帳單', ${q(f.seriesId)}, 'ai_inference', '自動掛期(回溯 ${VERSION})', 899) ON CONFLICT(document_id, field_key) DO NOTHING;`,
    `INSERT INTO document_extracted_fields (document_id, field_key, label, value, normalized_value, extraction_source, source_note, sort_order) VALUES (${q(f.docId)}, 'billing_month', '帳單月份', ${q(f.month)}, ${q(f.month)}, 'ai_inference', '自動掛期(回溯 ${VERSION})', 900) ON CONFLICT(document_id, field_key) DO NOTHING;`,
  );
}
const sqlPath = join(OUT, `recurring-periods-backfill_${tag}.sql`);
writeFileSync(
  sqlPath,
  `-- recurring_periods_backfill.ts ${VERSION}(${tag}):定期繳費期次回溯。Theo 確認後才執行;需要 migration 0010–0012 與 recurring-merge SQL 之後。\n` +
    `-- 期次 ${sorted.length} 列 + 新掛文件欄位 ${newDocFields.length * 2} 列 = 約 ${sorted.length + newDocFields.length * 2} 列寫入(D1 每日上限 10 萬列,一次可以做完)。\n` +
    sql.join("\n") +
    "\n",
);

const byStatus = new Map<string, number>();
for (const p of sorted) byStatus.set(p.status, (byStatus.get(p.status) ?? 0) + 1);
console.log(`series ${series.length};期次 ${sorted.length}(${[...byStatus].map(([k, v]) => `${k} ${v}`).join("、")})`);
console.log(`已掛文件轉換:${linked.length} 份文件、${linkedMonths} 個帳單月份;未掛文件 dry-run ${unlinkedChecked} 份,高信心新掛 ${newDocFields.length} 份`);
console.log(`對帳單明細 ${lines.length} 筆(涵蓋到 ${coveredThrough ?? "—"})`);
console.log(`review ${review.length} 列`);
for (const w of watchSummary) console.log(`  ${w}`);
console.log(`TSV:${tsvPath}`);
console.log(`review:${reviewPath}`);
console.log(`SQL:${sqlPath}(約 ${sorted.length + newDocFields.length * 2} 列寫入)`);
