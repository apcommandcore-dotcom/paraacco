// @paraacco/db schema —— 對應規格文件(vaultlink-v2-design-spec-20260902.md)第 2 節資料模型,
// 以及缺口清單第 1 點「D1 資料表設計」。用 Drizzle ORM(sqlite-core)定義,web/api/document-worker
// 共用同一份 schema 與型別。
//
// 列舉值說明(SQLite 沒有原生 enum,一律用 TEXT,應用層檢查):
//   ownership          'per' | 'corp' | 'advance' | 'custody' | 'transfer'          (規格 2.1)
//   purchase/doc status 'queued' | 'ocr' | 'extract' | 'review' | 'archived'
//                       | 'failed' | 'retry' | 'dup'                                (規格 2.2)
//   asset status        'active' | 'scrap' | 'moving' | 'archived'                  (規格 2.2)
//   transfer status      'pending' | 'approved' | 'rejected'                         (規格 2.11)
//   member scope          'personal_corp' | 'corp' | 'corp_readonly'                  (規格 2.12)
//
// 設計取捨:規格文件裡的「收件匣(Inbox)」與「待覆核(Review)」在 UI 上是兩個分頁,但兩者
// 本質上是同一份 documents 資料在不同 status 下的檢視,這裡不另外建 inbox/review_queue 表,
// 用 documents.status + documents.pipelineStep 表示。關聯候選(match candidates)則是即時運算
// (見 @paraacco/domain 的 rankCandidates),不落地存表。

import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// 成員與角色(RBAC)—— 規格 2.12
// ---------------------------------------------------------------------------
export const members = sqliteTable(
  "members",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    // 'admin' | 'finance' | 'owner' | 'external_readonly'(可擴充,見缺口清單第 3 點)
    role: text("role").notNull(),
    // 'personal_corp' | 'corp' | 'corp_readonly'
    scope: text("scope").notNull(),
    status: text("status").notNull().default("active"), // 'active' | 'invited' | 'disabled'
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    emailIdx: uniqueIndex("members_email_idx").on(t.email),
  }),
);

// ---------------------------------------------------------------------------
// 分類樹 —— 規格 2.7,個人/公司分開建樹
// ---------------------------------------------------------------------------
export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    ownershipScope: text("ownership_scope").notNull(), // 'per' | 'corp'
    parentId: text("parent_id"),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    scopeIdx: index("categories_scope_idx").on(t.ownershipScope, t.parentId),
  }),
);

// ---------------------------------------------------------------------------
// 供應商主檔 —— 規格 2.6(含強制覆核規則,邏輯在 @paraacco/domain)
// ---------------------------------------------------------------------------
export const vendors = sqliteTable(
  "vendors",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    taxId: text("tax_id"),
    defaultOwnership: text("default_ownership").notNull(), // 'per' | 'corp'
    defaultCategoryId: text("default_category_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    taxIdIdx: uniqueIndex("vendors_tax_id_idx").on(t.taxId),
    nameIdx: index("vendors_name_idx").on(t.name),
  }),
);

export const vendorAliases = sqliteTable(
  "vendor_aliases",
  {
    vendorId: text("vendor_id")
      .notNull()
      .references(() => vendors.id),
    alias: text("alias").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.vendorId, t.alias] }),
    aliasIdx: index("vendor_aliases_alias_idx").on(t.alias),
  }),
);

// ---------------------------------------------------------------------------
// 採購案 —— 規格 2.3
// ---------------------------------------------------------------------------
export const purchases = sqliteTable(
  "purchases",
  {
    id: text("id").primaryKey(), // PUR-YYYY-NNNNNN
    ownership: text("ownership").notNull(),
    purchaseDate: text("purchase_date").notNull(), // YYYY-MM-DD
    vendorId: text("vendor_id").references(() => vendors.id),
    vendorNameRaw: text("vendor_name_raw").notNull(),
    summary: text("summary").notNull(),
    subNote: text("sub_note"),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("TWD"),
    categoryId: text("category_id").references(() => categories.id),
    accountType: text("account_type"), // 固定資產／支出／固定資產耗材／預付費用...
    payer: text("payer"),
    reimbursementStatus: text("reimbursement_status").notNull().default("not_applicable"), // not_applicable|pending|reimbursed
    status: text("status").notNull().default("archived"),
    warrantyEndDate: text("warranty_end_date"),
    orderNo: text("order_no"),
    invoiceNo: text("invoice_no"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    ownershipIdx: index("purchases_ownership_idx").on(t.ownership),
    statusIdx: index("purchases_status_idx").on(t.status),
    vendorIdx: index("purchases_vendor_idx").on(t.vendorId),
    warrantyIdx: index("purchases_warranty_idx").on(t.warrantyEndDate),
  }),
);

export const purchaseTags = sqliteTable(
  "purchase_tags",
  {
    purchaseId: text("purchase_id")
      .notNull()
      .references(() => purchases.id),
    tag: text("tag").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.purchaseId, t.tag] }),
    tagIdx: index("purchase_tags_tag_idx").on(t.tag),
  }),
);

// ---------------------------------------------------------------------------
// 資產 —— 規格 2.4
// ---------------------------------------------------------------------------
export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(), // AST-YYYY-NNNNNN(個人資產另有 AST-PER-* 格式,人工指定)
    ownership: text("ownership").notNull(),
    name: text("name").notNull(),
    categoryId: text("category_id").references(() => categories.id),
    brand: text("brand"),
    model: text("model"),
    serialNo: text("serial_no"),
    acquiredDate: text("acquired_date"),
    holderEntity: text("holder_entity"),
    keeper: text("keeper"),
    location: text("location"),
    warrantyEndDate: text("warranty_end_date"),
    status: text("status").notNull().default("active"),
    purchaseId: text("purchase_id").references(() => purchases.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    ownershipIdx: index("assets_ownership_idx").on(t.ownership),
    statusIdx: index("assets_status_idx").on(t.status),
    serialIdx: index("assets_serial_idx").on(t.serialNo),
    purchaseIdx: index("assets_purchase_idx").on(t.purchaseId),
    warrantyIdx: index("assets_warranty_idx").on(t.warrantyEndDate),
  }),
);

// ---------------------------------------------------------------------------
// 文件(Inbox + 待覆核 + 已歸檔,同一張表,狀態機驅動)—— 規格 2.5、2.9、3.5
// ---------------------------------------------------------------------------
export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(), // DOC-YYYY-NNNNNN
    ownership: text("ownership").notNull(),
    vendorId: text("vendor_id").references(() => vendors.id),
    vendorNameRaw: text("vendor_name_raw"),
    fileName: text("file_name").notNull(),
    docTypeCode: text("doc_type_code"), // INV/WAR/RET/DEL/ORD/SUB/MAN,見 @paraacco/shared
    docDate: text("doc_date"),
    amountCents: integer("amount_cents"),
    currency: text("currency").default("TWD"),
    ocrConfidence: integer("ocr_confidence"), // 0-100,整體信心分數
    source: text("source").notNull(), // 'web_upload' | 'mobile_scan' | 'email_forward'
    status: text("status").notNull().default("queued"),
    pipelineStep: integer("pipeline_step").notNull().default(1), // 1-8,見 @paraacco/domain pipeline.ts
    sha256: text("sha256"),
    r2Key: text("r2_key"),
    purchaseId: text("purchase_id").references(() => purchases.id),
    assetId: text("asset_id").references(() => assets.id),
    duplicateOfDocumentId: text("duplicate_of_document_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    ownershipIdx: index("documents_ownership_idx").on(t.ownership),
    statusIdx: index("documents_status_idx").on(t.status),
    purchaseIdx: index("documents_purchase_idx").on(t.purchaseId),
    assetIdx: index("documents_asset_idx").on(t.assetId),
    sha256Idx: index("documents_sha256_idx").on(t.sha256),
  }),
);

// 單一文件的 OCR 擷取欄位明細 —— 規格 2.9(待覆核畫面右欄「OCR 擷取欄位」)
export const documentFields = sqliteTable(
  "document_fields",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id),
    fieldKey: text("field_key").notNull(), // 例:invoiceNo、serial、wEnd
    label: text("label").notNull(), // 例:發票號碼、序號／IMEI、保固迄日
    value: text("value"),
    confidence: integer("confidence"), // 0-100
    isMono: integer("is_mono", { mode: "boolean" }).notNull().default(false),
    sourceNote: text("source_note"), // 例:QR Code 解碼、OCR 第 1 頁標題區
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => ({
    docIdx: index("document_fields_document_idx").on(t.documentId),
  }),
);

// 處理歷程(階段 + 重試次數)—— 規格 2.10 Processing History
export const processingHistory = sqliteTable(
  "processing_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id),
    stage: text("stage").notNull(),
    attempt: integer("attempt").notNull().default(1),
    occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    docIdx: index("processing_history_document_idx").on(t.documentId),
  }),
);

// ---------------------------------------------------------------------------
// 歸屬移轉 —— 規格 2.11(不得直接覆寫歸屬,須走申請→核准流程)
// ---------------------------------------------------------------------------
export const transfers = sqliteTable(
  "transfers",
  {
    id: text("id").primaryKey(), // TRF-NNNNNN
    targetType: text("target_type").notNull(), // 'purchase' | 'asset'
    targetId: text("target_id").notNull(),
    fromOwnership: text("from_ownership").notNull(),
    toOwnership: text("to_ownership").notNull(),
    reason: text("reason").notNull(),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => members.id),
    approvedBy: text("approved_by").references(() => members.id),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    decidedAt: text("decided_at"),
  },
  (t) => ({
    targetIdx: index("transfers_target_idx").on(t.targetType, t.targetId),
    statusIdx: index("transfers_status_idx").on(t.status),
  }),
);

// ---------------------------------------------------------------------------
// 稽核日誌 / 近期動態 —— 規格 2.10 Audit Log、3.1 近期動態側欄共用同一張表
// ---------------------------------------------------------------------------
export const activityLog = sqliteTable(
  "activity_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityType: text("entity_type").notNull(), // 'purchase' | 'asset' | 'document' | 'transfer' | 'vendor'
    entityId: text("entity_id").notNull(),
    kind: text("kind").notNull(), // 'review' | 'ocr' | 'import' | 'transfer' | 'failed' | 'dup' | 'archive'
    text: text("text").notNull(),
    actorMemberId: text("actor_member_id").references(() => members.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    entityIdx: index("activity_log_entity_idx").on(t.entityType, t.entityId),
    createdIdx: index("activity_log_created_idx").on(t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// 人類可讀 ID 流水號(PUR-2026-000183 等)—— 應用層 upsert+1,搭配 @paraacco/domain 的
// formatSequentialId 使用,見 sequences.ts
// ---------------------------------------------------------------------------
export const idSequences = sqliteTable(
  "id_sequences",
  {
    entity: text("entity").notNull(), // 'PUR' | 'AST' | 'DOC' | 'TRF'
    year: integer("year").notNull(),
    lastSeq: integer("last_seq").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.entity, t.year] }),
  }),
);
