// 月報表(2026-09-29)——以物件為一列(CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md 2.1),依主文件是否掛
// 定期繳費(recurring_series_id)分「定期繳費/一般消費」兩段(CODE_TASK_recurring-bills-single-page_20260929_V1.01.md 2.4),
// 混合歸屬時公司/個人小計依品項拆分(5.3)。附件永遠不計入金額;還沒合併的單獨文件視為只有一份文件的物件。
// 組表邏輯在 @paraacco/domain 的 buildMonthlyReport()。
//
//   GET /api/reports/monthly?month=YYYY-MM&status=valid|archived|all&ownership=corp|per|…

import { Hono } from "hono";
import { and, eq, inArray, ne } from "drizzle-orm";
import {
  createDb,
  documentExtractedFields,
  documentFiles,
  documentPurchaseLinks,
  documents,
  purchaseAttachments,
  advancePayees,
  itemCategories,
  purchaseItems,
  vendors,
} from "@paraacco/db";
import { buildMonthlyReport, docKindOf } from "@paraacco/domain";
import type { Bindings } from "../bindings";
import { canAccessOwnership } from "../middleware/auth";
import { getMixedOwnershipCutoff } from "../purchase-objects";

export const reportsRoute = new Hono<{ Bindings: Bindings }>();

const STATUS_MODES: Record<string, (s: string) => boolean> = {
  valid: (s) => s !== "dup" && s !== "failed" && s !== "ignored",
  archived: (s) => s === "archived",
  all: () => true,
};

reportsRoute.get("/monthly", async (c) => {
  const month = c.req.query("month") ?? "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return c.json({ error: "invalid_month" }, 400);
  const statusMode = c.req.query("status") ?? "valid";
  const statusFilter = STATUS_MODES[statusMode];
  if (!statusFilter) return c.json({ error: "invalid_status", allowed: Object.keys(STATUS_MODES) }, 400);
  const ownership = c.req.query("ownership") || null;
  const scope = c.get("auth").scope;

  const db = createDb(c.env.DB);
  const [docRows, fieldRows, fileRows, linkRows, itemRows, attachmentRows, cutoff] = await Promise.all([
    db.select({ doc: documents, vendorName: vendors.name }).from(documents).leftJoin(vendors, eq(vendors.id, documents.vendorId)),
    db
      .select({ documentId: documentExtractedFields.documentId, fieldKey: documentExtractedFields.fieldKey, value: documentExtractedFields.value })
      .from(documentExtractedFields)
      .where(inArray(documentExtractedFields.fieldKey, ["recurring_series_id", "finance_doc_type"])),
    db
      .select({ documentId: documentFiles.documentId, localPath: documentFiles.localPath })
      .from(documentFiles)
      .where(and(eq(documentFiles.kind, "original"), eq(documentFiles.isCurrent, true))),
    db.select().from(documentPurchaseLinks).where(ne(documentPurchaseLinks.relationKind, "duplicate_evidence")),
    db.select().from(purchaseItems),
    db.select({ purchaseId: purchaseAttachments.purchaseId, purchaseItemId: purchaseAttachments.purchaseItemId, kind: purchaseAttachments.kind }).from(purchaseAttachments),
    getMixedOwnershipCutoff(db),
  ]);
  const series = new Map(fieldRows.filter((f) => f.fieldKey === "recurring_series_id").map((f) => [f.documentId, f.value]));
  const financeType = new Map(fieldRows.filter((f) => f.fieldKey === "finance_doc_type").map((f) => [f.documentId, f.value]));
  const paths = new Map(fileRows.map((f) => [f.documentId, f.localPath]));

  const report = buildMonthlyReport({
    month,
    docs: docRows
      .filter(({ doc }) => canAccessOwnership(scope, doc.ownership))
      .map(({ doc, vendorName }) => ({
        id: doc.id,
        status: doc.status,
        ownership: doc.ownership,
        invoiceDate: doc.invoiceDate,
        docDate: doc.docDate,
        vendorName: vendorName ?? null,
        vendorNameRaw: doc.vendorNameRaw,
        invoiceNo: doc.invoiceNo,
        amountCents: doc.amountCents,
        displayName: doc.displayName,
        recurringSeriesId: series.get(doc.id) ?? null,
        kind: docKindOf({ docTypeCode: doc.docTypeCode, financeDocType: financeType.get(doc.id), localPath: paths.get(doc.id), invoiceNo: doc.invoiceNo }),
      })),
    links: linkRows,
    items: itemRows,
    attachments: attachmentRows,
    statusFilter,
    ownershipFilter: ownership,
    cutoff,
  });
  // V1.02 7.5:類別/專案小計、代墊與不列帳清單由 buildMonthlyReport 算;這裡補上類別與請款對象名稱供顯示。
  const [cats, payees] = await Promise.all([
    db.select({ id: itemCategories.id, name: itemCategories.name, parentId: itemCategories.parentId }).from(itemCategories),
    db.select({ id: advancePayees.id, name: advancePayees.name }).from(advancePayees),
  ]);
  return c.json({ ...report, cutoff, statusMode, categoryNames: Object.fromEntries(cats.map((x) => [x.id, x.name])), payeeNames: Object.fromEntries(payees.map((x) => [x.id, x.name])) });
});
