// paraacco 回溯合併建議 merge_suggestions.ts V1.0(2026-09-29)
// CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md 第三節「回溯」:對現有全部文件跑自動合併規則 1–5,
// 只列不動。規則本身在 @paraacco/domain 的 purchase-objects.ts(跟 API、覆核頁同一份)。
//
// 輸入:wrangler d1 execute --remote --json 的唯讀 SELECT 快照(docs / fields / links 三份,見報告裡的指令)。
// 輸出(OUT,預設 ~/dev/_reports/paraacco/merge-objects/):
//   merge-suggestions_<時間>.tsv    一列一份附件:建議物件、主文件、附件、規則編號、金額、歸屬是否衝突…;accept 欄留給 Theo 勾選(Y)
//   duplicate-suggestions_<時間>.tsv 規則 1(同一發票號碼)→ 走既有重複檔流程
//   duplicates_<時間>.sql            重複檔的 D1 UPDATE(status='dup'、duplicate_of_document_id),確認後才執行
//   merge-simulation_<時間>.md       指定月份(預設 2026-09)合併前後的月報表小計對照
// 寫入物件由 scripts/merge_objects.py 讀勾選後的 TSV,呼叫 POST /api/archive/purchase-objects(migration 0011 + API 部署後)。
//
// 執行:node <repo>/node_modules/.pnpm/tsx@4.23.13/node_modules/tsx/dist/cli.mjs scripts/merge_suggestions.ts <docs.json> <fields.json> <links.json> [YYYY-MM]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ATTACHMENT_ROLE_LABELS,
  MERGE_RULE_LABELS,
  buildMergeSuggestions,
  buildMonthlyReport,
  docKindOf,
  toMergeDoc,
  type ReportLinkInput,
} from "../packages/domain/src/index";

const VERSION = "V1.0";
const OUT = process.env.OUT ?? join(homedir(), "dev/_reports/paraacco/merge-objects");

type Row = Record<string, unknown>;
const rows = (p: string): Row[] => {
  const data = JSON.parse(readFileSync(p, "utf8"));
  return Array.isArray(data) ? data[0].results : data.results;
};

const [docsPath, fieldsPath, linksPath, monthArg] = process.argv.slice(2);
if (!docsPath || !fieldsPath || !linksPath) {
  console.error("用法:merge_suggestions.ts <docs.json> <fields.json> <links.json> [YYYY-MM]");
  process.exit(2);
}
const month = monthArg ?? "2026-09";
const docRows = rows(docsPath);
const fieldsByDoc = new Map<string, Map<string, string | null>>();
for (const f of rows(fieldsPath)) {
  const m = fieldsByDoc.get(f.document_id as string) ?? new Map<string, string | null>();
  m.set(f.field_key as string, (f.value as string) ?? null);
  fieldsByDoc.set(f.document_id as string, m);
}
const existingLinks = rows(linksPath);
const objectByDoc = new Map(existingLinks.filter((l) => l.relation_kind !== "duplicate_evidence").map((l) => [l.document_id as string, l.purchase_id as string]));

const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const docs = docRows.map((r) =>
  toMergeDoc(
    {
      id: r.id as string,
      status: r.status as string,
      ownership: r.ownership as string,
      docTypeCode: s(r.doc_type_code),
      invoiceDate: s(r.invoice_date),
      docDate: s(r.doc_date),
      amountCents: n(r.amount_cents),
      invoiceNo: s(r.invoice_no),
      orderNo: s(r.order_no),
      brand: s(r.brand),
      model: s(r.model),
      serialNo: s(r.serial_no),
      vendorNameRaw: s(r.vendor_name_raw),
    },
    fieldsByDoc.get(r.id as string) ?? new Map(),
    s(r.local_path),
    s(r.vendor_name),
    objectByDoc.get(r.id as string) ?? null,
  ),
);
// 已經在物件裡的文件不再建議(回溯時正式 D1 還沒有物件,這裡是保險)。
const candidates = docs.filter((d) => !d.purchaseId);
const byId = new Map(docs.map((d) => [d.id, d]));
const { objects, duplicates } = buildMergeSuggestions(candidates);

const tag = new Date(Date.now() + 8 * 3600e3).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
mkdirSync(OUT, { recursive: true });
const tsvCell = (v: unknown) => String(v ?? "").replace(/[\t\n]/g, " ");
const nt = (c: number | null) => (c === null ? "" : String(Math.round(c / 100)));
const ownLabel: Record<string, string> = { corp: "公司", per: "個人", advance: "代墊", custody: "代管" };

// ---- merge-suggestions TSV ----
const header = [
  "accept",
  "建議物件",
  "主文件",
  "主文件種類",
  "主文件日期",
  "主文件供應商",
  "主文件發票號",
  "物件金額",
  "主文件歸屬",
  "附件",
  "附件角色",
  "附件歸屬",
  "歸屬是否衝突",
  "規則編號",
  "規則說明",
  "供應商比對不確定",
  "品項行號",
  "說明",
];
const lines = [header.join("\t")];
objects.forEach((o, i) => {
  const p = byId.get(o.primaryId)!;
  for (const a of o.attachments) {
    const d = byId.get(a.documentId)!;
    lines.push(
      [
        "",
        `S${String(i + 1).padStart(3, "0")}`,
        p.id,
        p.kind,
        p.date,
        p.vendorName,
        p.invoiceNo,
        nt(o.amountCents),
        ownLabel[p.ownership] ?? p.ownership,
        d.id,
        `${a.role} ${ATTACHMENT_ROLE_LABELS[a.role]}`,
        ownLabel[d.ownership] ?? d.ownership,
        d.ownership !== p.ownership ? "衝突(以主文件為準)" : "",
        a.rule,
        MERGE_RULE_LABELS[a.rule],
        a.uncertain ? "是" : "",
        a.itemLineNo ?? "",
        (o.amountCents !== null && o.amountCents < 0 ? "⚠ 主文件金額為負(退款/折讓),建立物件會被拒,請另外處理;" : "") + a.note,
      ]
        .map(tsvCell)
        .join("\t"),
    );
  }
});
const suggestionsPath = join(OUT, `merge-suggestions_${tag}.tsv`);
writeFileSync(suggestionsPath, lines.join("\n") + "\n");

// ---- duplicates ----
const dupPath = join(OUT, `duplicate-suggestions_${tag}.tsv`);
writeFileSync(
  dupPath,
  ["accept\t保留\t重複檔\t金額\t日期\t說明", ...duplicates.map((d) => ["", d.keepId, d.duplicateId, nt(byId.get(d.keepId)!.amountCents), byId.get(d.keepId)!.date, d.note].map(tsvCell).join("\t"))].join("\n") + "\n",
);
const dupSqlPath = join(OUT, `duplicates_${tag}.sql`);
writeFileSync(
  dupSqlPath,
  `-- merge_suggestions.ts ${VERSION}:規則 1(同一發票號碼)重複檔,走既有重複檔流程(status='dup'、duplicate_of_document_id)。Theo 確認後才執行。共 ${duplicates.length} 組。\n` +
    duplicates
      .map(
        (d) =>
          `UPDATE documents SET status = 'dup', duplicate_of_document_id = '${d.keepId}', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = '${d.duplicateId}' AND status NOT IN ('dup','ignored');\n` +
          `INSERT INTO activity_log (entity_type, entity_id, kind, text) VALUES ('document', '${d.duplicateId}', 'dup', '回溯合併:與 ${d.keepId} 發票號碼相同,標為重複檔');`,
      )
      .join("\n") +
    "\n",
);

// ---- 月報表模擬:合併前(現行,文件為列)vs 合併後(物件為列)----
const fields = (id: string) => fieldsByDoc.get(id) ?? new Map<string, string | null>();
const reportDocs = docRows.map((r) => ({
  id: r.id as string,
  status: r.status as string,
  ownership: r.ownership as string,
  invoiceDate: s(r.invoice_date),
  docDate: s(r.doc_date),
  vendorName: s(r.vendor_name),
  vendorNameRaw: s(r.vendor_name_raw),
  invoiceNo: s(r.invoice_no),
  amountCents: n(r.amount_cents),
  displayName: s(r.display_name),
  recurringSeriesId: s(r.recurring_series_id),
  kind: docKindOf({ docTypeCode: s(r.doc_type_code), financeDocType: fields(r.id as string).get("finance_doc_type"), localPath: s(r.local_path), invoiceNo: s(r.invoice_no) }),
}));
const valid = (st: string) => st !== "dup" && st !== "failed";
const before = buildMonthlyReport({ month, docs: reportDocs, links: [], items: [], attachments: [], statusFilter: valid });
const dupSet = new Set(duplicates.map((d) => d.duplicateId));
const simLinks: ReportLinkInput[] = objects.flatMap((o) => [
  { documentId: o.primaryId, purchaseId: `SIM-${o.primaryId}`, relationKind: "primary", attachmentRole: null, purchaseItemId: null },
  ...o.attachments.map((a) => ({ documentId: a.documentId, purchaseId: `SIM-${o.primaryId}`, relationKind: "supporting", attachmentRole: a.role, purchaseItemId: null })),
]);
const after = buildMonthlyReport({
  month,
  docs: reportDocs.map((d) => (dupSet.has(d.id) ? { ...d, status: "dup" } : d)),
  links: simLinks,
  items: [],
  attachments: [],
  statusFilter: valid,
});
const own = (r: typeof before, k: string) => r.total.byOwnership[k]?.cents ?? 0;
const cnt = (r: typeof before, k: string) => r.total.byOwnership[k]?.count ?? 0;
const keys = [...new Set([...Object.keys(before.total.byOwnership), ...Object.keys(after.total.byOwnership)])].sort();
const monthObjects = objects.filter((o) => (byId.get(o.primaryId)!.date ?? "").startsWith(month));
const md = [
  `# 月報表 ${month}:回溯合併前後對照(模擬,${VERSION},${tag})`,
  "",
  "合併前 = 現行月報表(一份文件一列,排除 dup/failed);合併後 = 以物件為列,套用全部合併建議 + 規則 1 重複檔標 dup。只是模擬,正式 D1 沒有寫入。",
  "",
  "| 歸屬 | 合併前筆數 | 合併前金額 | 合併後筆數 | 合併後金額 | 差額 |",
  "|---|---:|---:|---:|---:|---:|",
  ...keys.map((k) => `| ${ownLabel[k] ?? k} | ${cnt(before, k)} | ${nt(own(before, k))} | ${cnt(after, k)} | ${nt(own(after, k))} | ${nt(own(after, k) - own(before, k))} |`),
  `| **總計** | ${before.total.count} | ${nt(before.total.cents)} | ${after.total.count} | ${nt(after.total.cents)} | ${nt(after.total.cents - before.total.cents)} |`,
  "",
  `合併後「定期繳費」段 ${after.recurring.rows.length} 列 NT$${nt(after.recurring.subtotals.cents)};「一般消費」段 ${after.general.rows.length} 列 NT$${nt(after.general.subtotals.cents)}。`,
  "",
  `## 這個月份的合併建議(${monthObjects.length} 個物件)`,
  "",
  "| 主文件 | 金額 | 附件(規則) | 歸屬衝突 |",
  "|---|---:|---|---|",
  ...monthObjects.map((o) => `| ${o.primaryId} | ${nt(o.amountCents)} | ${o.attachments.map((a) => `${a.documentId}(${a.rule})`).join("、")} | ${o.ownershipConflict ? "是" : ""} |`),
  "",
  `## 這個月份的重複檔(規則 1)`,
  "",
  ...duplicates.filter((d) => (byId.get(d.keepId)!.date ?? "").startsWith(month)).map((d) => `- 保留 ${d.keepId},${d.duplicateId} 標重複:${d.note}`),
  "",
].join("\n");
const simPath = join(OUT, `merge-simulation-${month}_${tag}.md`);
writeFileSync(simPath, md);

const ruleCount = new Map<number, number>();
for (const o of objects) for (const a of o.attachments) ruleCount.set(a.rule, (ruleCount.get(a.rule) ?? 0) + 1);
console.log(`文件 ${docs.length} 份(已在物件裡的 ${docs.length - candidates.length} 份不列)`);
console.log(`建議物件 ${objects.length} 個、附件 ${objects.reduce((a, o) => a + o.attachments.length, 0)} 份;規則分布 ${[...ruleCount.entries()].sort().map(([r, c]) => `${r}:${c}`).join(" ")};歸屬衝突 ${objects.filter((o) => o.ownershipConflict).length} 個`);
console.log(`重複檔(規則 1)${duplicates.length} 組`);
console.log(`合併建議:${suggestionsPath}`);
console.log(`重複檔:${dupPath}、${dupSqlPath}`);
console.log(`${month} 模擬:${simPath}`);
console.log(`  合併前 總計 ${before.total.count} 列 NT$${nt(before.total.cents)};合併後 ${after.total.count} 列 NT$${nt(after.total.cents)}`);
