// 物件(採購案)= 一筆消費 —— 2026-09-29,CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md。
// 建立物件、加入/移出文件(主文件自動接手)、品項、非單據附件、物件詳情、合併候選。規則本身在 @paraacco/domain
// 的 purchase-objects.ts(純函式),這裡只負責讀寫 D1。
//
// 資料模型(見 packages/db schema 的 document_purchase_links / purchase_items / purchase_attachments 註解):
//   - 一份文件最多屬於一個物件(document_purchase_links 的 PK 是 (document_id, purchase_id),多物件由這裡擋)。
//   - relation_kind 'primary' = 主文件(每個物件一份),'supporting' = 附件(attachment_role 標類型,purchase_item_id 標品項層)。
//   - purchases 的日期/供應商/金額/歸屬/發票號從主文件同步(syncPurchaseFromPrimary),主文件換人時重新同步。
//   - NAS 上的附件改名(<主文件檔名去副檔名>_附件_<類型>_<序號>)由本機 archive.py 出計畫,Worker 不碰 NAS。

import { and, eq, inArray, ne } from "drizzle-orm";
import {
  activityLog,
  appSettings,
  assets,
  documentExtractedFields,
  documentFiles,
  documentPurchaseLinks,
  documents,
  itemRules,
  nextId,
  purchaseAttachments,
  purchaseItems,
  purchases,
  statementLines,
  transfers,
  vendors,
  type Db,
} from "@paraacco/db";
import {
  ATTACHMENT_ROLES,
  DEFAULT_MIXED_OWNERSHIP_CUTOFF,
  MIXED_OWNERSHIP_CUTOFF_KEY,
  defaultAttachmentRole,
  docKindOf,
  findMergePairsFor,
  isMixedOwnership,
  itemAmountMismatch,
  itemsFromLineItems,
  mixedOwnershipNeedsWarning,
  pickItemRule,
  pickPrimary,
  resolveVendorTaxId,
  shouldTakeOverPrimary,
  toMergeDoc,
  type AttachmentRole,
  type DocKind,
  type MergeDoc,
} from "@paraacco/domain";

export interface Actor {
  memberId: string | null;
  name: string | null;
}

export class ObjectError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const OBJECT_FIELD_KEYS = ["line_items", "finance_doc_type", "vendorTaxId", "vendorTaxIdQr", "vendorTaxIdPrinted", "vendorTaxIdSource"];

interface DocInfo {
  doc: typeof documents.$inferSelect;
  fields: Map<string, string | null>;
  localPath: string | null;
  vendorName: string | null;
  kind: DocKind;
}

async function loadDocInfos(db: Db, ids: string[]): Promise<Map<string, DocInfo>> {
  if (!ids.length) return new Map();
  const [docRows, fieldRows, fileRows] = await Promise.all([
    db
      .select({ doc: documents, vendorName: vendors.name })
      .from(documents)
      .leftJoin(vendors, eq(vendors.id, documents.vendorId))
      .where(inArray(documents.id, ids)),
    db
      .select({ documentId: documentExtractedFields.documentId, fieldKey: documentExtractedFields.fieldKey, value: documentExtractedFields.value })
      .from(documentExtractedFields)
      .where(and(inArray(documentExtractedFields.documentId, ids), inArray(documentExtractedFields.fieldKey, OBJECT_FIELD_KEYS))),
    db
      .select({ documentId: documentFiles.documentId, localPath: documentFiles.localPath })
      .from(documentFiles)
      .where(and(inArray(documentFiles.documentId, ids), eq(documentFiles.kind, "original"), eq(documentFiles.isCurrent, true))),
  ]);
  const out = new Map<string, DocInfo>();
  for (const r of docRows) {
    const fields = new Map(fieldRows.filter((f) => f.documentId === r.doc.id).map((f) => [f.fieldKey, f.value]));
    const localPath = fileRows.find((f) => f.documentId === r.doc.id)?.localPath ?? null;
    out.set(r.doc.id, {
      doc: r.doc,
      fields,
      localPath,
      vendorName: r.vendorName ?? null,
      kind: docKindOf({ docTypeCode: r.doc.docTypeCode, financeDocType: fields.get("finance_doc_type"), localPath, invoiceNo: r.doc.invoiceNo }),
    });
  }
  return out;
}

async function linkOf(db: Db, documentId: string) {
  const [row] = await db
    .select()
    .from(documentPurchaseLinks)
    .where(and(eq(documentPurchaseLinks.documentId, documentId), ne(documentPurchaseLinks.relationKind, "duplicate_evidence")))
    .limit(1);
  return row ?? null;
}

async function objectLinks(db: Db, purchaseId: string) {
  return db
    .select()
    .from(documentPurchaseLinks)
    .where(and(eq(documentPurchaseLinks.purchaseId, purchaseId), ne(documentPurchaseLinks.relationKind, "duplicate_evidence")));
}

function purchaseFieldsFromPrimary(info: DocInfo, itemName: string | null) {
  const d = info.doc;
  if (d.amountCents !== null && d.amountCents < 0) {
    throw new ObjectError(409, "negative_amount", "退款/折讓(金額為負)的單據不能當物件主文件");
  }
  const date = d.invoiceDate ?? d.docDate ?? new Date().toISOString().slice(0, 10);
  const vendor = info.vendorName ?? d.vendorNameRaw ?? "—";
  return {
    ownership: d.ownership,
    purchaseDate: date.slice(0, 10),
    vendorId: d.vendorId,
    vendorNameRaw: vendor,
    summary: (d.displayName ?? itemName ?? vendor).slice(0, 200),
    amountCents: d.amountCents ?? 0,
    currency: d.currency ?? "TWD",
    invoiceNo: d.invoiceNo,
    orderNo: d.orderNo,
    status: ["draft", "review", "archived"].includes(d.status) ? d.status : "review",
  };
}

async function newItemRows(db: Db, purchaseId: string, info: DocInfo) {
  const drafts = itemsFromLineItems(info.fields.get("line_items"));
  const year = Number((info.doc.invoiceDate ?? info.doc.docDate ?? new Date().toISOString()).slice(0, 4)) || new Date().getFullYear();
  // V1.02 7.4:同一賣方統編(+ 品名關鍵字)的自動規則,建品項時直接帶入類別/歸屬/專案,category_source='rule'。
  const taxId = resolveVendorTaxId({
    qr: info.fields.get("vendorTaxIdQr"),
    printed: info.fields.get("vendorTaxIdPrinted"),
    legacy: info.fields.get("vendorTaxId"),
  }).taxId;
  const rules = taxId ? await db.select().from(itemRules).where(eq(itemRules.isActive, true)) : [];
  const rows: Array<typeof purchaseItems.$inferInsert> = [];
  for (const d of drafts) {
    const rule = pickItemRule(rules, taxId, d.name);
    rows.push({
      ...(rule
        ? {
            categoryId: rule.categoryId ?? null,
            categorySource: "rule",
            ...(rule.ownership ? { ownership: rule.ownership } : {}),
            ...(rule.projectCode ? { projectCode: rule.projectCode } : {}),
          }
        : {}),
      id: await nextId(db, "PIT", year),
      purchaseId,
      lineNo: d.lineNo,
      name: d.name.slice(0, 200),
      quantity: d.quantity,
      unitPriceCents: d.unitPriceCents,
      amountCents: d.amountCents,
      brand: d.brand,
      model: d.model,
      serialNo: d.serialNo,
      source: "invoice_line",
    });
  }
  return rows;
}

/** D1 單一語句最多 100 個綁定參數;purchase_items 一列約 13 個欄位,多列 INSERT 每 6 列切一句
 * (一張好市多發票就有 30 行明細,不切會 too many SQL variables)。 */
export function itemInsertStatements(db: Db, rows: Array<typeof purchaseItems.$inferInsert>) {
  const out = [];
  for (let i = 0; i < rows.length; i += 6) out.push(db.insert(purchaseItems).values(rows.slice(i, i + 6)));
  return out;
}

function assertAttachable(info: DocInfo | undefined, documentId: string) {
  if (!info) throw new ObjectError(404, "document_not_found", `找不到文件 ${documentId}`);
  if (["ignored", "dup"].includes(info.doc.status)) {
    throw new ObjectError(409, "document_excluded", `${documentId} 狀態是 ${info.doc.status},不能加入物件`);
  }
}

function validRole(role: string | null | undefined): AttachmentRole | null {
  return role && (ATTACHMENT_ROLES as readonly string[]).includes(role) ? (role as AttachmentRole) : null;
}

async function log(db: Db, entityType: string, entityId: string, text: string, actor: Actor) {
  await db.insert(activityLog).values({ entityType, entityId, kind: "review", text, actorMemberId: actor.memberId });
}

/** 建立物件:主文件 + 附件,並依主文件的發票明細自動建立品項(每一行一個)。
 * attachments[].itemLineNo:掛到第幾行的品項(規則 5 的建議),沒有就掛物件層。 */
export async function createObject(
  db: Db,
  primaryDocumentId: string,
  actor: Actor,
  attachments: Array<{ documentId: string; role?: string | null; itemLineNo?: number | null }> = [],
  linkedBy: "manual" | "auto" | "import" = "manual",
): Promise<{ purchaseId: string; itemIds: string[]; ownershipConflicts: string[] }> {
  const ids = [primaryDocumentId, ...attachments.map((a) => a.documentId)];
  if (new Set(ids).size !== ids.length) throw new ObjectError(400, "duplicate_document", "同一份文件重複出現");
  const infos = await loadDocInfos(db, ids);
  for (const id of ids) {
    assertAttachable(infos.get(id), id);
    const existing = await linkOf(db, id);
    if (existing) throw new ObjectError(409, "already_in_object", `${id} 已經屬於物件 ${existing.purchaseId}`);
  }
  const primary = infos.get(primaryDocumentId)!;
  const year = Number((primary.doc.invoiceDate ?? primary.doc.docDate ?? new Date().toISOString()).slice(0, 4)) || new Date().getFullYear();
  const purchaseId = await nextId(db, "PUR", year);
  const items = await newItemRows(db, purchaseId, primary);
  const base = purchaseFieldsFromPrimary(primary, items[0]?.name ?? null);
  const itemByLine = new Map(items.map((i) => [i.lineNo, i.id]));

  const conflicts: string[] = [];
  const statements: unknown[] = [
    db.insert(purchases).values({ id: purchaseId, ...base, createdByMemberId: actor.memberId }),
    db.insert(documentPurchaseLinks).values({
      documentId: primaryDocumentId,
      purchaseId,
      relationKind: "primary",
      linkedBy,
      createdByMemberId: actor.memberId,
    }),
  ];
  statements.push(...itemInsertStatements(db, items));
  for (const a of attachments) {
    const info = infos.get(a.documentId)!;
    if (info.doc.ownership !== primary.doc.ownership) conflicts.push(a.documentId);
    statements.push(
      db.insert(documentPurchaseLinks).values({
        documentId: a.documentId,
        purchaseId,
        relationKind: "supporting",
        attachmentRole: validRole(a.role) ?? defaultAttachmentRole(info.kind),
        purchaseItemId: a.itemLineNo ? (itemByLine.get(a.itemLineNo) ?? null) : null,
        linkedBy,
        createdByMemberId: actor.memberId,
      }),
    );
  }
  statements.push(
    db.insert(activityLog).values({
      entityType: "purchase",
      entityId: purchaseId,
      kind: "review",
      text: `${actor.name ?? "系統"} 建立物件:主文件 ${primaryDocumentId}${attachments.length ? `,附件 ${attachments.map((a) => a.documentId).join("、")}` : ""}${items.length ? `,自動建立 ${items.length} 個品項` : ""}${conflicts.length ? `;歸屬衝突(以主文件為準):${conflicts.join("、")}` : ""}`,
      actorMemberId: actor.memberId,
    }),
    ...ids.map((id) =>
      db.insert(activityLog).values({
        entityType: "document",
        entityId: id,
        kind: "review",
        text: `${actor.name ?? "系統"} 加入物件 ${purchaseId}(${id === primaryDocumentId ? "主文件" : "附件"})`,
        actorMemberId: actor.memberId,
      }),
    ),
  );
  await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
  return { purchaseId, itemIds: items.map((i) => i.id), ownershipConflicts: conflicts };
}

/** 主文件換人時:用新主文件重新同步物件欄位;原本的品項如果全是舊主文件自動建的(沒改過歸屬、沒掛附件),換成新主文件的明細。 */
async function syncPurchaseFromPrimary(db: Db, purchaseId: string, actor: Actor): Promise<void> {
  const links = await objectLinks(db, purchaseId);
  const primaryLink = links.find((l) => l.relationKind === "primary");
  if (!primaryLink) return;
  const infos = await loadDocInfos(db, [primaryLink.documentId]);
  const primary = infos.get(primaryLink.documentId)!;
  const existingItems = await db.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, purchaseId));
  const attachedItemIds = new Set([
    ...links.map((l) => l.purchaseItemId).filter(Boolean),
    ...(await db.select({ id: purchaseAttachments.purchaseItemId }).from(purchaseAttachments).where(eq(purchaseAttachments.purchaseId, purchaseId))).map(
      (r) => r.id,
    ),
  ]);
  const replaceable =
    existingItems.every((i) => i.source === "invoice_line" && !i.ownership && !i.warrantyEndDate && !attachedItemIds.has(i.id)) &&
    itemsFromLineItems(primary.fields.get("line_items")).length > 0;
  const statements: unknown[] = [];
  let newItems: Array<typeof purchaseItems.$inferInsert> = [];
  if (replaceable) {
    newItems = await newItemRows(db, purchaseId, primary);
    if (existingItems.length) statements.push(db.delete(purchaseItems).where(eq(purchaseItems.purchaseId, purchaseId)));
    statements.push(...itemInsertStatements(db, newItems));
  }
  const firstName = (replaceable ? newItems[0]?.name : existingItems.sort((a, b) => a.lineNo - b.lineNo)[0]?.name) ?? null;
  statements.push(
    db
      .update(purchases)
      .set({ ...purchaseFieldsFromPrimary(primary, firstName), updatedAt: new Date().toISOString() })
      .where(eq(purchases.id, purchaseId)),
  );
  if (replaceable && existingItems.length !== newItems.length) {
    statements.push(
      db.insert(activityLog).values({
        entityType: "purchase",
        entityId: purchaseId,
        kind: "review",
        text: `${actor.name ?? "系統"} 主文件改為 ${primary.doc.id},品項依新主文件明細重建(${existingItems.length} → ${newItems.length})`,
        actorMemberId: actor.memberId,
      }),
    );
  }
  await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
}

/** 文件加入物件(或在同一物件內改角色/改掛品項)。
 *  role 未指定:發票且物件目前主文件不是發票 → 接手主文件;其餘依文件種類給附件類型。
 *  role='primary':指定成主文件(原主文件轉附件)。itemId:掛到品項層(null = 物件層)。 */
export async function attachDocument(
  db: Db,
  purchaseId: string,
  documentId: string,
  opts: { role?: string | null; itemId?: string | null; actor: Actor; linkedBy?: "manual" | "auto" | "import"; confidenceScore?: number | null },
): Promise<{ relationKind: "primary" | "supporting"; attachmentRole: AttachmentRole | null; tookOverPrimary: boolean; ownershipConflict: boolean }> {
  const [purchase] = await db.select().from(purchases).where(eq(purchases.id, purchaseId)).limit(1);
  if (!purchase) throw new ObjectError(404, "purchase_not_found", `找不到物件 ${purchaseId}`);
  if (opts.role && opts.role !== "primary" && !validRole(opts.role)) throw new ObjectError(400, "invalid_role", `不認得的角色 ${opts.role}`);
  if (opts.itemId) {
    const [item] = await db.select().from(purchaseItems).where(eq(purchaseItems.id, opts.itemId)).limit(1);
    if (!item || item.purchaseId !== purchaseId) throw new ObjectError(400, "invalid_item", `品項 ${opts.itemId} 不屬於物件 ${purchaseId}`);
  }
  const existing = await linkOf(db, documentId);
  if (existing && existing.purchaseId !== purchaseId) {
    throw new ObjectError(409, "already_in_object", `${documentId} 已經屬於物件 ${existing.purchaseId},請先從那個物件移出`);
  }
  const links = await objectLinks(db, purchaseId);
  const primaryLink = links.find((l) => l.relationKind === "primary") ?? null;
  const infos = await loadDocInfos(db, [documentId, ...(primaryLink && primaryLink.documentId !== documentId ? [primaryLink.documentId] : [])]);
  const info = infos.get(documentId);
  assertAttachable(info, documentId);
  const primaryInfo = primaryLink ? infos.get(primaryLink.documentId) ?? info! : null;

  const wantPrimary =
    opts.role === "primary" ||
    (!opts.role && !existing && shouldTakeOverPrimary(info!.kind, primaryLink && primaryLink.documentId !== documentId ? primaryInfo!.kind : null));
  const now = new Date().toISOString();
  const statements: unknown[] = [];
  let tookOver = false;

  if (wantPrimary && primaryLink?.documentId !== documentId) {
    if (primaryLink) {
      statements.push(
        db
          .update(documentPurchaseLinks)
          .set({ relationKind: "supporting", attachmentRole: defaultAttachmentRole(primaryInfo!.kind), purchaseItemId: null })
          .where(and(eq(documentPurchaseLinks.documentId, primaryLink.documentId), eq(documentPurchaseLinks.purchaseId, purchaseId))),
      );
    }
    tookOver = !!primaryLink;
  }
  const relationKind: "primary" | "supporting" = wantPrimary ? "primary" : "supporting";
  const attachmentRole = relationKind === "primary" ? null : (validRole(opts.role) ?? (existing?.attachmentRole as AttachmentRole | null) ?? defaultAttachmentRole(info!.kind));
  const purchaseItemId = relationKind === "primary" ? null : opts.itemId !== undefined ? opts.itemId : (existing?.purchaseItemId ?? null);
  if (existing) {
    statements.push(
      db
        .update(documentPurchaseLinks)
        .set({ relationKind, attachmentRole, purchaseItemId })
        .where(and(eq(documentPurchaseLinks.documentId, documentId), eq(documentPurchaseLinks.purchaseId, purchaseId))),
    );
  } else {
    statements.push(
      db.insert(documentPurchaseLinks).values({
        documentId,
        purchaseId,
        relationKind,
        attachmentRole,
        purchaseItemId,
        linkedBy: opts.linkedBy ?? "manual",
        confidenceScore: opts.confidenceScore ?? null,
        createdByMemberId: opts.actor.memberId,
      }),
    );
  }
  const ownershipConflict = relationKind === "supporting" && !!primaryInfo && info!.doc.ownership !== primaryInfo.doc.ownership;
  const roleText = relationKind === "primary" ? "主文件" : `附件(${attachmentRole}${purchaseItemId ? `,品項 ${purchaseItemId}` : ""})`;
  statements.push(
    db.insert(activityLog).values({
      entityType: "document",
      entityId: documentId,
      kind: "review",
      text: `${opts.actor.name ?? "系統"} ${existing ? "改為" : "加入物件 " + purchaseId + " 當"}${roleText}${tookOver ? `,原主文件 ${primaryLink!.documentId} 轉為附件` : ""}${ownershipConflict ? `;歸屬與主文件不同(以主文件 ${primaryInfo!.doc.ownership} 為準)` : ""}`,
      actorMemberId: opts.actor.memberId,
    }),
    db.update(documents).set({ updatedAt: now }).where(eq(documents.id, documentId)),
  );
  await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
  if (relationKind === "primary") await syncPurchaseFromPrimary(db, purchaseId, opts.actor);
  return { relationKind, attachmentRole, tookOverPrimary: tookOver, ownershipConflict };
}

/** 從物件移出文件,文件恢復成獨立物件(統計上是只有一份文件的物件)。移出主文件時由剩下的文件依優先順序接手;
 * 最後一份文件移出時,物件(含品項、非單據附件)一起刪掉——物件已被對帳/資產/移轉參照時不刪,回 409。 */
export async function detachDocument(db: Db, purchaseId: string, documentId: string, actor: Actor): Promise<{ newPrimaryId: string | null; objectDeleted: boolean }> {
  const links = await objectLinks(db, purchaseId);
  const link = links.find((l) => l.documentId === documentId);
  if (!link) throw new ObjectError(404, "not_in_object", `${documentId} 不在物件 ${purchaseId} 裡`);
  const rest = links.filter((l) => l.documentId !== documentId);
  const statements: unknown[] = [
    db.delete(documentPurchaseLinks).where(and(eq(documentPurchaseLinks.documentId, documentId), eq(documentPurchaseLinks.purchaseId, purchaseId))),
    db.insert(activityLog).values({
      entityType: "document",
      entityId: documentId,
      kind: "review",
      text: `${actor.name ?? "系統"} 從物件 ${purchaseId} 移出,恢復成獨立文件`,
      actorMemberId: actor.memberId,
    }),
  ];
  if (!rest.length) {
    const [st, as, tr] = await Promise.all([
      db.select({ id: statementLines.id }).from(statementLines).where(eq(statementLines.matchedPurchaseId, purchaseId)).limit(1),
      db.select({ id: assets.id }).from(assets).where(eq(assets.purchaseId, purchaseId)).limit(1),
      db.select({ id: transfers.id }).from(transfers).where(and(eq(transfers.targetType, "purchase"), eq(transfers.targetId, purchaseId))).limit(1),
    ]);
    if (st.length || as.length || tr.length) {
      throw new ObjectError(409, "object_referenced", "這是物件的最後一份文件,物件已被對帳/資產/歸屬移轉參照,不能移出");
    }
    statements.push(
      db.delete(purchaseAttachments).where(eq(purchaseAttachments.purchaseId, purchaseId)),
      db.delete(purchaseItems).where(eq(purchaseItems.purchaseId, purchaseId)),
      db.delete(purchases).where(eq(purchases.id, purchaseId)),
      db.insert(activityLog).values({
        entityType: "purchase",
        entityId: purchaseId,
        kind: "review",
        text: `${actor.name ?? "系統"} 移出最後一份文件 ${documentId},物件解散`,
        actorMemberId: actor.memberId,
      }),
    );
    await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
    return { newPrimaryId: null, objectDeleted: true };
  }
  let newPrimaryId: string | null = null;
  if (link.relationKind === "primary") {
    const infos = await loadDocInfos(db, rest.map((l) => l.documentId));
    const next = pickPrimary(
      rest.map((l) => ({ id: l.documentId, kind: infos.get(l.documentId)?.kind ?? "other", date: infos.get(l.documentId)?.doc.invoiceDate ?? null })),
    )!;
    newPrimaryId = next.id;
    statements.push(
      db
        .update(documentPurchaseLinks)
        .set({ relationKind: "primary", attachmentRole: null, purchaseItemId: null })
        .where(and(eq(documentPurchaseLinks.documentId, next.id), eq(documentPurchaseLinks.purchaseId, purchaseId))),
    );
  }
  await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
  if (newPrimaryId) await syncPurchaseFromPrimary(db, purchaseId, actor);
  return { newPrimaryId, objectDeleted: false };
}

export async function getMixedOwnershipCutoff(db: Db): Promise<string> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, MIXED_OWNERSHIP_CUTOFF_KEY)).limit(1);
  return row?.value ?? DEFAULT_MIXED_OWNERSHIP_CUTOFF;
}

/** 物件詳情:主文件 + 附件(依角色)、品項(含各自的附件)、非單據附件、旗標(混合歸屬、品項金額不符、截止日後混合歸屬警告)。 */
export async function getObjectDetail(db: Db, purchaseId: string) {
  const [purchase] = await db.select().from(purchases).where(eq(purchases.id, purchaseId)).limit(1);
  if (!purchase) return null;
  const [links, items, extra, cutoff] = await Promise.all([
    objectLinks(db, purchaseId),
    db.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, purchaseId)),
    db.select().from(purchaseAttachments).where(eq(purchaseAttachments.purchaseId, purchaseId)),
    getMixedOwnershipCutoff(db),
  ]);
  const infos = await loadDocInfos(db, links.map((l) => l.documentId));
  const docs = links
    .map((l) => {
      const info = infos.get(l.documentId);
      return {
        documentId: l.documentId,
        relationKind: l.relationKind,
        attachmentRole: l.attachmentRole,
        purchaseItemId: l.purchaseItemId,
        linkedBy: l.linkedBy,
        kind: info?.kind ?? "other",
        docTypeCode: info?.doc.docTypeCode ?? null,
        status: info?.doc.status ?? null,
        ownership: info?.doc.ownership ?? null,
        amountCents: info?.doc.amountCents ?? null,
        invoiceNo: info?.doc.invoiceNo ?? null,
        date: info?.doc.invoiceDate ?? info?.doc.docDate ?? null,
        vendorName: info?.vendorName ?? null,
        vendorNameRaw: info?.doc.vendorNameRaw ?? null,
        displayName: info?.doc.displayName ?? null,
        localPath: info?.localPath ?? null,
      };
    })
    .sort((a, b) => (a.relationKind === "primary" ? -1 : b.relationKind === "primary" ? 1 : a.documentId.localeCompare(b.documentId)));
  const primary = docs.find((d) => d.relationKind === "primary") ?? null;
  const objectOwnership = primary?.ownership ?? purchase.ownership;
  const sortedItems = [...items].sort((a, b) => a.lineNo - b.lineNo || a.id.localeCompare(b.id));
  const mixed = isMixedOwnership(objectOwnership, sortedItems);
  return {
    purchase,
    primary,
    documents: docs,
    items: sortedItems.map((it) => ({
      ...it,
      effectiveOwnership: it.ownership ?? objectOwnership,
      documentIds: docs.filter((d) => d.purchaseItemId === it.id).map((d) => d.documentId),
      attachmentIds: extra.filter((a) => a.purchaseItemId === it.id).map((a) => a.id),
    })),
    attachments: extra,
    flags: {
      mixedOwnership: mixed,
      itemAmountMismatch: itemAmountMismatch(primary?.amountCents ?? purchase.amountCents, sortedItems),
      mixedOwnershipWarning: mixedOwnershipNeedsWarning(primary?.date ?? purchase.purchaseDate, mixed, cutoff),
      cutoff,
      ownershipConflicts: docs.filter((d) => d.relationKind !== "primary" && d.ownership && d.ownership !== objectOwnership).map((d) => d.documentId),
    },
  };
}

/** 全部文件(合併建議用):種類、賣方統編(QR > 印字)、發票品項、目前所屬物件。 */
export async function loadMergeDocs(db: Db): Promise<MergeDoc[]> {
  const [docRows, fieldRows, fileRows, linkRows] = await Promise.all([
    db.select({ doc: documents, vendorName: vendors.name }).from(documents).leftJoin(vendors, eq(vendors.id, documents.vendorId)),
    db
      .select({ documentId: documentExtractedFields.documentId, fieldKey: documentExtractedFields.fieldKey, value: documentExtractedFields.value })
      .from(documentExtractedFields)
      .where(inArray(documentExtractedFields.fieldKey, OBJECT_FIELD_KEYS)),
    db
      .select({ documentId: documentFiles.documentId, localPath: documentFiles.localPath })
      .from(documentFiles)
      .where(and(eq(documentFiles.kind, "original"), eq(documentFiles.isCurrent, true))),
    db
      .select({ documentId: documentPurchaseLinks.documentId, purchaseId: documentPurchaseLinks.purchaseId })
      .from(documentPurchaseLinks)
      .where(ne(documentPurchaseLinks.relationKind, "duplicate_evidence")),
  ]);
  const fieldsByDoc = new Map<string, Map<string, string | null>>();
  for (const f of fieldRows) {
    const m = fieldsByDoc.get(f.documentId) ?? new Map<string, string | null>();
    m.set(f.fieldKey, f.value);
    fieldsByDoc.set(f.documentId, m);
  }
  const pathByDoc = new Map(fileRows.map((f) => [f.documentId, f.localPath]));
  const objectByDoc = new Map(linkRows.map((l) => [l.documentId, l.purchaseId]));
  return docRows.map(({ doc, vendorName }) =>
    toMergeDoc(doc, fieldsByDoc.get(doc.id) ?? new Map(), pathByDoc.get(doc.id) ?? null, vendorName ?? null, objectByDoc.get(doc.id) ?? null),
  );
}

/** 覆核頁「合併到物件」:這份文件的候選(另一份文件,或它已屬於的物件),依規則強弱排序。 */
export async function mergeCandidatesFor(db: Db, documentId: string) {
  const docs = await loadMergeDocs(db);
  const self = docs.find((d) => d.id === documentId);
  if (!self) return null;
  const byId = new Map(docs.map((d) => [d.id, d]));
  const pairs = findMergePairsFor(documentId, docs);
  return {
    documentId,
    currentPurchaseId: self.purchaseId ?? null,
    candidates: pairs.map((p) => {
      const otherId = p.primaryId === documentId ? p.otherId : p.primaryId;
      const other = byId.get(otherId)!;
      const selfIsPrimary = p.primaryId === documentId;
      return {
        rule: p.rule,
        note: p.note,
        uncertain: p.uncertain,
        duplicate: p.rule === 1,
        documentId: otherId,
        purchaseId: other.purchaseId ?? null,
        otherKind: other.kind,
        otherOwnership: other.ownership,
        otherAmountCents: other.amountCents,
        otherDate: other.date,
        otherVendorName: other.vendorName,
        otherInvoiceNo: other.invoiceNo,
        /** 合併後這份文件的角色建議。 */
        suggestedRole: selfIsPrimary ? "primary" : defaultAttachmentRole(self.kind),
        itemLineNo: p.itemLineNo ?? null,
        ownershipConflict: other.ownership !== self.ownership,
      };
    }),
  };
}
