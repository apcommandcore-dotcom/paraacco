// 供應商一律由賣方統編對應主檔(2026-09-29,CODE_TASK_vendor-name-from-taxid_20260929.md)——
// stage-7 vendor-check、POST /api/vendors 建檔後補對應(R-V4)、每日排程、「待建檔供應商」清單共用。
//
// 統編的決定一律走 @paraacco/domain 的 resolveVendorTaxId()(QR > 印字、檢查碼、不一致註記),
// 讀的是 document_extracted_fields 的 vendorTaxIdQr / vendorTaxIdPrinted / vendorTaxId(舊資料)。
// vendorTaxId 那一列刻意不改寫:它是外部判讀寫回的擷取欄位(sourceNote 帶「外部擷取:」前綴),
// 改成 vendor_lookup 會讓 stage-3 認不出「已有外部擷取結果」(見 @paraacco/domain isExternalExtractionField)。
// 比對結果另外存三列系統欄位(extractionSource='vendor_lookup'):vendor_status、vendorTaxIdSource、vendorTaxIdNote。

import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { activityLog, documentExtractedFields, documentFiles, documents, vendors, type Db } from "@paraacco/db";
import {
  findVendorByTaxId,
  resolveVendorTaxId,
  vendorStatusOf,
  VENDOR_STATUS_FIELD_KEY,
  VENDOR_TAX_ID_FIELD_KEY,
  VENDOR_TAX_ID_NOTE_FIELD_KEY,
  VENDOR_TAX_ID_PRINTED_FIELD_KEY,
  VENDOR_TAX_ID_QR_FIELD_KEY,
  VENDOR_TAX_ID_SOURCE_FIELD_KEY,
  type VendorStatus,
  type VendorTaxIdResolution,
  type VendorTaxIdSource,
} from "@paraacco/domain";

const TAX_ID_FIELD_KEYS = [VENDOR_TAX_ID_FIELD_KEY, VENDOR_TAX_ID_QR_FIELD_KEY, VENDOR_TAX_ID_PRINTED_FIELD_KEY, VENDOR_TAX_ID_SOURCE_FIELD_KEY];
const EXCLUDED_STATUSES = ["ignored", "dup"];

interface FieldRow {
  documentId: string;
  fieldKey: string;
  value: string | null;
  isUserConfirmed?: boolean;
}

function resolutionFromFields(rows: FieldRow[], bodyTaxId?: string | null): VendorTaxIdResolution {
  const byKey = new Map(rows.map((r) => [r.fieldKey, r.value]));
  return resolveVendorTaxId({
    qr: byKey.get(VENDOR_TAX_ID_QR_FIELD_KEY),
    printed: byKey.get(VENDOR_TAX_ID_PRINTED_FIELD_KEY),
    legacy: byKey.get(VENDOR_TAX_ID_FIELD_KEY) ?? bodyTaxId,
    legacySource: byKey.get(VENDOR_TAX_ID_SOURCE_FIELD_KEY),
  });
}

function systemFieldStatements(db: Db, documentId: string, resolution: VendorTaxIdResolution, status: VendorStatus, confirmedKeys: Set<string>) {
  const rows: Array<{ fieldKey: string; label: string; value: string | null }> = [
    { fieldKey: VENDOR_STATUS_FIELD_KEY, label: "供應商比對", value: status },
    { fieldKey: VENDOR_TAX_ID_SOURCE_FIELD_KEY, label: "賣方統編來源", value: resolution.source },
    { fieldKey: VENDOR_TAX_ID_NOTE_FIELD_KEY, label: "賣方統編註記", value: resolution.note },
  ];
  return rows
    .filter((r) => !confirmedKeys.has(r.fieldKey))
    .map((r) =>
      r.value === null
        ? db
            .delete(documentExtractedFields)
            .where(and(eq(documentExtractedFields.documentId, documentId), eq(documentExtractedFields.fieldKey, r.fieldKey)))
        : db
            .insert(documentExtractedFields)
            .values({
              documentId,
              fieldKey: r.fieldKey,
              label: r.label,
              value: r.value,
              extractionSource: "vendor_lookup",
              sourceNote: "賣方統編對應主檔(CODE_TASK_vendor-name-from-taxid_20260929)",
              sortOrder: 880,
            })
            .onConflictDoUpdate({
              target: [documentExtractedFields.documentId, documentExtractedFields.fieldKey],
              set: { value: r.value, extractionSource: "vendor_lookup" },
            }),
    );
}

export interface VendorCheckResult {
  matchedVendorId: string | null;
  matchedVendorName: string | null;
  vendorStatus: VendorStatus;
  vendorTaxId: string | null;
  vendorTaxIdSource: VendorTaxIdSource;
  note: string | null;
  forcedReview: boolean;
}

/** stage-7:只用賣方統編查主檔,寫 documents.vendorId 與三列系統欄位。bodyTaxId 是 pipeline 這次 OCR
 * 結果裡的 vendorTaxId(Gemini 模式;外部寫回時欄位已經在 DB 裡)。 */
export async function checkDocumentVendor(db: Db, documentId: string, bodyTaxId?: string | null): Promise<VendorCheckResult> {
  const [fieldRows, vendorRows] = await Promise.all([
    db
      .select({
        documentId: documentExtractedFields.documentId,
        fieldKey: documentExtractedFields.fieldKey,
        value: documentExtractedFields.value,
        isUserConfirmed: documentExtractedFields.isUserConfirmed,
      })
      .from(documentExtractedFields)
      .where(
        and(
          eq(documentExtractedFields.documentId, documentId),
          inArray(documentExtractedFields.fieldKey, [...TAX_ID_FIELD_KEYS, VENDOR_STATUS_FIELD_KEY, VENDOR_TAX_ID_NOTE_FIELD_KEY]),
        ),
      ),
    db.select({ id: vendors.id, name: vendors.name, taxId: vendors.taxId }).from(vendors),
  ]);
  const resolution = resolutionFromFields(fieldRows, bodyTaxId);
  const matched = findVendorByTaxId(resolution.taxId, vendorRows);
  const status = vendorStatusOf(resolution, matched);
  const confirmedKeys = new Set(fieldRows.filter((f) => f.isUserConfirmed).map((f) => f.fieldKey));
  const now = new Date().toISOString();

  const statements: unknown[] = [
    db.update(documents).set({ vendorId: matched?.id ?? null, updatedAt: now }).where(eq(documents.id, documentId)),
    ...systemFieldStatements(db, documentId, resolution, status, confirmedKeys),
  ];
  // Gemini 模式 OCR 讀到的統編(外部寫回的已經在 DB 裡)沒有寫過 vendorTaxId 時補一列,讓清單查得到。
  if (bodyTaxId && !fieldRows.some((f) => f.fieldKey === VENDOR_TAX_ID_FIELD_KEY)) {
    statements.push(
      db
        .insert(documentExtractedFields)
        .values({ documentId, fieldKey: VENDOR_TAX_ID_FIELD_KEY, label: "賣方統編", value: bodyTaxId, extractionSource: "ocr" })
        .onConflictDoNothing(),
    );
  }
  if (resolution.note && fieldRows.find((f) => f.fieldKey === VENDOR_TAX_ID_NOTE_FIELD_KEY)?.value !== resolution.note) {
    statements.push(
      db.insert(activityLog).values({ entityType: "document", entityId: documentId, kind: "review", text: `供應商比對:${resolution.note}` }),
    );
  }
  await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);

  return {
    matchedVendorId: matched?.id ?? null,
    matchedVendorName: matched?.name ?? null,
    vendorStatus: status,
    vendorTaxId: resolution.taxId ?? resolution.rawInvalid,
    vendorTaxIdSource: resolution.source,
    note: resolution.note,
    forcedReview: matched === null,
  };
}

async function loadUnmatchedDocs(db: Db) {
  const docRows = await db
    .select({
      id: documents.id,
      status: documents.status,
      vendorNameRaw: documents.vendorNameRaw,
      invoiceDate: documents.invoiceDate,
      docDate: documents.docDate,
      amountCents: documents.amountCents,
      localPath: documentFiles.localPath,
    })
    .from(documents)
    .leftJoin(
      documentFiles,
      and(eq(documentFiles.documentId, documents.id), eq(documentFiles.kind, "original"), eq(documentFiles.isCurrent, true)),
    )
    .where(and(isNull(documents.vendorId), notInArray(documents.status, EXCLUDED_STATUSES)));
  const fieldRows = await db
    .select({ documentId: documentExtractedFields.documentId, fieldKey: documentExtractedFields.fieldKey, value: documentExtractedFields.value })
    .from(documentExtractedFields)
    .innerJoin(documents, eq(documents.id, documentExtractedFields.documentId))
    .where(
      and(
        isNull(documents.vendorId),
        notInArray(documents.status, EXCLUDED_STATUSES),
        inArray(documentExtractedFields.fieldKey, TAX_ID_FIELD_KEYS),
      ),
    );
  const fieldsByDoc = new Map<string, FieldRow[]>();
  for (const f of fieldRows) fieldsByDoc.set(f.documentId, [...(fieldsByDoc.get(f.documentId) ?? []), f]);
  return docRows.map((d) => ({ ...d, resolution: resolutionFromFields(fieldsByDoc.get(d.id) ?? []) }));
}

/** R-V4:新增供應商成功後(或每日排程),把「統編 = 已建檔、vendorId 還是空」的文件補上 vendorId。
 * NAS 歸檔改名由本機 scripts/archive.py 做(Worker 碰不到 NAS):補上 vendorId 的文件,下一次
 * `archive.py --source api` 就會出現在計畫裡。onlyTaxId 有值時只處理那個統編。 */
export async function backfillVendorIds(
  db: Db,
  opts: { onlyTaxId?: string; actorMemberId?: string | null; actorName?: string | null } = {},
): Promise<Array<{ documentId: string; vendorId: string; vendorName: string; taxId: string }>> {
  const [docs, vendorRows] = await Promise.all([
    loadUnmatchedDocs(db),
    db.select({ id: vendors.id, name: vendors.name, taxId: vendors.taxId }).from(vendors),
  ]);
  const hits = docs.flatMap((d) => {
    if (!d.resolution.taxId || (opts.onlyTaxId && d.resolution.taxId !== opts.onlyTaxId)) return [];
    const v = findVendorByTaxId(d.resolution.taxId, vendorRows);
    return v ? [{ documentId: d.id, vendorId: v.id, vendorName: v.name, taxId: d.resolution.taxId }] : [];
  });
  if (!hits.length) return [];
  const now = new Date().toISOString();
  const statements = hits.flatMap((h) => [
    db.update(documents).set({ vendorId: h.vendorId, updatedAt: now }).where(and(eq(documents.id, h.documentId), isNull(documents.vendorId))),
    db
      .insert(documentExtractedFields)
      .values({
        documentId: h.documentId,
        fieldKey: VENDOR_STATUS_FIELD_KEY,
        label: "供應商比對",
        value: "matched",
        extractionSource: "vendor_lookup" as const,
        sourceNote: "賣方統編對應主檔(CODE_TASK_vendor-name-from-taxid_20260929)",
        sortOrder: 880,
      })
      .onConflictDoUpdate({
        target: [documentExtractedFields.documentId, documentExtractedFields.fieldKey],
        set: { value: "matched", extractionSource: "vendor_lookup" },
      }),
    db.insert(activityLog).values({
      entityType: "document",
      entityId: h.documentId,
      kind: "review",
      text: `${opts.actorName ?? "系統"} 建檔後自動對應供應商:統編 ${h.taxId} → ${h.vendorName}(待 archive.py 歸檔/改名)`,
      actorMemberId: opts.actorMemberId ?? null,
    }),
  ]);
  // D1 batch 單次上限 100 句左右就夠用;大量時分段。
  for (let i = 0; i < statements.length; i += 90) {
    const chunk = statements.slice(i, i + 90);
    await db.batch(chunk as unknown as Parameters<typeof db.batch>[0]);
  }
  return hits;
}

export interface PendingVendorGroup {
  taxId: string;
  sources: VendorTaxIdSource[];
  ocrNames: string[];
  documentCount: number;
  documentIds: string[];
  dateFrom: string | null;
  dateTo: string | null;
  totalCents: number;
  localPaths: string[];
}

export interface UnreadableTaxIdDoc {
  documentId: string;
  rawTaxId: string | null;
  ocrName: string | null;
  date: string | null;
  amountCents: number | null;
  localPath: string | null;
}

/** R-V3 清單:依統編彙總「統編有效但未建檔」的文件(同一統編一行),另列「統編無法辨識」的文件。 */
export async function listPendingVendors(db: Db): Promise<{ pending: PendingVendorGroup[]; unreadable: UnreadableTaxIdDoc[] }> {
  const docs = await loadUnmatchedDocs(db);
  const groups = new Map<string, PendingVendorGroup>();
  const unreadable: UnreadableTaxIdDoc[] = [];
  for (const d of docs) {
    const date = d.invoiceDate ?? d.docDate ?? null;
    if (!d.resolution.taxId) {
      unreadable.push({
        documentId: d.id,
        rawTaxId: d.resolution.rawInvalid,
        ocrName: d.vendorNameRaw,
        date,
        amountCents: d.amountCents,
        localPath: d.localPath ?? null,
      });
      continue;
    }
    const g = groups.get(d.resolution.taxId) ?? {
      taxId: d.resolution.taxId,
      sources: [],
      ocrNames: [],
      documentCount: 0,
      documentIds: [],
      dateFrom: null,
      dateTo: null,
      totalCents: 0,
      localPaths: [],
    };
    if (!g.sources.includes(d.resolution.source)) g.sources.push(d.resolution.source);
    if (d.vendorNameRaw && !g.ocrNames.includes(d.vendorNameRaw)) g.ocrNames.push(d.vendorNameRaw);
    g.documentCount += 1;
    g.documentIds.push(d.id);
    if (date && (!g.dateFrom || date < g.dateFrom)) g.dateFrom = date;
    if (date && (!g.dateTo || date > g.dateTo)) g.dateTo = date;
    g.totalCents += d.amountCents ?? 0;
    if (d.localPath) g.localPaths.push(d.localPath);
    groups.set(d.resolution.taxId, g);
  }
  const pending = [...groups.values()].sort((a, b) => b.documentCount - a.documentCount || a.taxId.localeCompare(b.taxId));
  unreadable.sort((a, b) => a.documentId.localeCompare(b.documentId));
  return { pending, unreadable };
}
