// @paraacco/db schema v2 —— 依 Perplexity 技術提案(vaultlinkv2technicalproposal.md)修正 v1 的
// 幾個實際問題,但刻意不做完整多租戶建模(見下方「範圍決策」)。
//
// 範圍決策(使用者確認,2026-09-02):
//   - 單一事務所,不建 organizations/users/memberships 四表拆分,維持扁平 members 表。
//     paraacco 介面的實際使用者只有「公司會計」與「負責人」兩種角色,個人代墊項目由這兩人
//     在系統裡登錄/覆核,不是由「本人」登入 paraacco 操作 —— 日後會有另一個獨立的個人帳單
//     上傳介面把資料匯進來,那個介面的使用者不會看到 paraacco 本身,所以不需要真的幫每個
//     提交者建帳號/角色。
//   - OCR pipeline 採 Cloudflare Queues + Workflows(見 apps/document-worker),不再是
//     apps/api 同步處理。
//
// 從 Perplexity 提案採用的修正(不管規模大小都是對的):
//   1. 歸屬移轉期間,ownership_kind 維持原值不變,「移轉中」是由 transfers 表裡是否存在
//      pending 申請推導出來的顯示狀態 —— 不再把 'transfer' 存成 ownership 的合法值。
//   2. R2 key 與業務關聯(purchaseId)脫鉤,採用 documentId/fileId 為主的穩定路徑(見
//      @paraacco/shared 的 r2-key.ts)。
//   3. 關聯評分要有分數上限與「強識別欄位衝突直接淘汰」邏輯(見 @paraacco/domain 的
//      matching.ts)。
//   4. document_type 的 SUB 不能同時代表訂閱與帳單,拆成 SUB(訂閱)／BIL(帳單)。
//   5. 文件檔案版本(document_files)、OCR 擷取欄位(document_extracted_fields)、處理中的
//      工作(document_processing_jobs)、處理事件歷程(document_processing_events)、關聯候選
//      (relation_candidates)分表,不塞進 documents 單一列。
//   6. 每個列舉欄位在 DB 層加 CHECK 約束,不只是註解說明。
//   7. 加入 document_fts(SQLite FTS5)供全文搜尋(見 search.ts),document_files 的 sha256
//      刻意不加資料庫層 UNIQUE 約束 —— 設計稿明確容許重複文件以獨立列存在、狀態設為 dup
//      讓人工覆核決定,加 UNIQUE 會讓這個工作流程在 INSERT 時直接失敗。

import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// 成員與角色 —— 規格 2.12,範圍限定為「公司會計」與「負責人」兩種實際會登入的角色 + admin
// ---------------------------------------------------------------------------
export const members = sqliteTable(
  "members",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull(), // 'admin' | 'accountant'(會計) | 'principal'(負責人)
    scope: text("scope").notNull(), // 'personal_corp' | 'corp' | 'corp_readonly'
    status: text("status").notNull().default("active"), // 'active' | 'invited' | 'disabled'
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    emailIdx: uniqueIndex("members_email_idx").on(t.email),
    roleCheck: check("members_role_check", sql`${t.role} IN ('admin', 'accountant', 'principal')`),
    scopeCheck: check("members_scope_check", sql`${t.scope} IN ('personal_corp', 'corp', 'corp_readonly')`),
    statusCheck: check("members_status_check", sql`${t.status} IN ('active', 'invited', 'disabled')`),
  }),
);

// ---------------------------------------------------------------------------
// 分類樹 —— 規格 2.7
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
    scopeCheck: check("categories_scope_check", sql`${t.ownershipScope} IN ('per', 'corp')`),
  }),
);

// ---------------------------------------------------------------------------
// 供應商主檔 —— 規格 2.6
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
    taxIdCheck: check("vendors_tax_id_check", sql`${t.taxId} IS NULL OR length(${t.taxId}) = 8`),
    ownershipCheck: check("vendors_ownership_check", sql`${t.defaultOwnership} IN ('per', 'corp')`),
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
// 採購案 —— 規格 2.3。ownership_kind 不含 'transfer'(見檔頭說明)。
// ---------------------------------------------------------------------------
export const purchases = sqliteTable(
  "purchases",
  {
    id: text("id").primaryKey(), // PUR-YYYY-NNNNNN
    ownership: text("ownership").notNull(), // 'per' | 'corp' | 'advance' | 'custody'
    purchaseDate: text("purchase_date").notNull(), // YYYY-MM-DD
    vendorId: text("vendor_id").references(() => vendors.id),
    vendorNameRaw: text("vendor_name_raw").notNull(),
    summary: text("summary").notNull(),
    subNote: text("sub_note"),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("TWD"),
    categoryId: text("category_id").references(() => categories.id),
    accountType: text("account_type"), // 固定資產／支出／固定資產耗材／預付費用...
    payerKind: text("payer_kind").notNull().default("company"), // 'personal' | 'company' | 'external'
    payer: text("payer"), // 實際付款人姓名(顯示用)
    reimbursementStatus: text("reimbursement_status").notNull().default("not_applicable"),
    status: text("status").notNull().default("archived"),
    warrantyEndDate: text("warranty_end_date"),
    orderNo: text("order_no"),
    invoiceNo: text("invoice_no"),
    createdByMemberId: text("created_by_member_id").references(() => members.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    ownershipIdx: index("purchases_ownership_idx").on(t.ownership),
    statusIdx: index("purchases_status_idx").on(t.status),
    vendorIdx: index("purchases_vendor_idx").on(t.vendorId),
    warrantyIdx: index("purchases_warranty_idx").on(t.warrantyEndDate),
    ownershipCheck: check("purchases_ownership_check", sql`${t.ownership} IN ('per', 'corp', 'advance', 'custody')`),
    payerKindCheck: check("purchases_payer_kind_check", sql`${t.payerKind} IN ('personal', 'company', 'external')`),
    reimbursementCheck: check(
      "purchases_reimbursement_check",
      sql`${t.reimbursementStatus} IN ('not_applicable', 'pending', 'submitted', 'approved', 'reimbursed', 'rejected')`,
    ),
    statusCheck: check("purchases_status_check", sql`${t.status} IN ('draft', 'review', 'archived', 'failed', 'retry', 'dup')`),
    amountCheck: check("purchases_amount_check", sql`${t.amountCents} >= 0`),
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
// 資產 —— 規格 2.4。ownership_kind 不含 'transfer'。
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
    createdByMemberId: text("created_by_member_id").references(() => members.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    ownershipIdx: index("assets_ownership_idx").on(t.ownership),
    statusIdx: index("assets_status_idx").on(t.status),
    serialIdx: index("assets_serial_idx").on(t.serialNo),
    purchaseIdx: index("assets_purchase_idx").on(t.purchaseId),
    warrantyIdx: index("assets_warranty_idx").on(t.warrantyEndDate),
    ownershipCheck: check("assets_ownership_check", sql`${t.ownership} IN ('per', 'corp', 'advance', 'custody')`),
    statusCheck: check("assets_status_check", sql`${t.status} IN ('active', 'scrap', 'moving', 'archived')`),
  }),
);

// ---------------------------------------------------------------------------
// 文件(邏輯文件本體)—— 規格 2.5、2.9、3.5。實體檔案見 document_files,
// OCR 欄位見 document_extracted_fields,與購買案/資產的關聯見 document_*_links
// (多對多,取代 v1 的單一 purchaseId/assetId 外鍵 —— 一份信用卡帳單可能對應多筆採購案)。
// ---------------------------------------------------------------------------
export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(), // DOC-YYYY-NNNNNN
    ownership: text("ownership").notNull(),
    vendorId: text("vendor_id").references(() => vendors.id),
    vendorNameRaw: text("vendor_name_raw"),
    docTypeCode: text("doc_type_code"), // INV/WAR/RET/DEL/ORD/SUB/BIL/MAN,見 @paraacco/shared
    docDate: text("doc_date"),
    invoiceNo: text("invoice_no"),
    orderNo: text("order_no"),
    serialNo: text("serial_no"),
    brand: text("brand"),
    model: text("model"),
    amountCents: integer("amount_cents"),
    currency: text("currency").default("TWD"),
    // 整體信心分數 0-100,由 @paraacco/domain 的 calculateOverallConfidence() 依必要欄位加權算出,
    // 不是 OCR provider 回傳值的直接平均。
    ocrConfidence: real("ocr_confidence"),
    source: text("source").notNull(), // 'web_upload' | 'mobile_scan' | 'email_forward' | 'api_import'
    status: text("status").notNull().default("queued"),
    duplicateOfDocumentId: text("duplicate_of_document_id"),
    createdByMemberId: text("created_by_member_id").references(() => members.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    archivedAt: text("archived_at"),
  },
  (t) => ({
    ownershipIdx: index("documents_ownership_idx").on(t.ownership),
    statusIdx: index("documents_status_idx").on(t.status),
    vendorIdx: index("documents_vendor_idx").on(t.vendorId),
    invoiceIdx: index("documents_invoice_idx").on(t.invoiceNo),
    orderIdx: index("documents_order_idx").on(t.orderNo),
    ownershipCheck: check("documents_ownership_check", sql`${t.ownership} IN ('per', 'corp', 'advance', 'custody')`),
    docTypeCheck: check(
      "documents_doc_type_check",
      sql`${t.docTypeCode} IS NULL OR ${t.docTypeCode} IN ('INV', 'WAR', 'RET', 'DEL', 'ORD', 'SUB', 'BIL', 'MAN')`,
    ),
    sourceCheck: check(
      "documents_source_check",
      sql`${t.source} IN ('web_upload', 'mobile_scan', 'email_forward', 'api_import')`,
    ),
    statusCheck: check(
      "documents_status_check",
      sql`${t.status} IN ('queued', 'validating', 'ocr', 'extract', 'classifying', 'matching', 'vendor_check', 'review', 'archived', 'failed', 'retry', 'dup', 'ignored')`,
    ),
    confidenceCheck: check(
      "documents_confidence_check",
      sql`${t.ocrConfidence} IS NULL OR (${t.ocrConfidence} >= 0 AND ${t.ocrConfidence} <= 100)`,
    ),
  }),
);

// 文件的實體檔案版本(R2 物件)—— 原始檔、正規化 PDF、頁面影像、縮圖、OCR JSON 原始結果。
// sha256 刻意不加 UNIQUE:同一份文件被重複上傳要能以獨立列存在、狀態設 dup 讓人工判斷,
// 不能在 INSERT 階段就被資料庫拒絕。
export const documentFiles = sqliteTable(
  "document_files",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id),
    kind: text("kind").notNull(), // 'original' | 'normalized_pdf' | 'page_image' | 'thumbnail' | 'ocr_json'
    r2Key: text("r2_key").notNull(),
    originalFileName: text("original_file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256"),
    pageNumber: integer("page_number"),
    isCurrent: integer("is_current", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    documentIdx: index("document_files_document_idx").on(t.documentId),
    sha256Idx: index("document_files_sha256_idx").on(t.sha256),
    r2KeyIdx: uniqueIndex("document_files_r2_key_idx").on(t.r2Key),
    kindCheck: check(
      "document_files_kind_check",
      sql`${t.kind} IN ('original', 'normalized_pdf', 'page_image', 'thumbnail', 'ocr_json')`,
    ),
    byteSizeCheck: check("document_files_byte_size_check", sql`${t.byteSize} >= 0`),
  }),
);

// 文件 ↔ 採購案 多對多(一份帳單/BIL 可能涵蓋多筆採購案)。
export const documentPurchaseLinks = sqliteTable(
  "document_purchase_links",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id),
    purchaseId: text("purchase_id")
      .notNull()
      .references(() => purchases.id),
    relationKind: text("relation_kind").notNull().default("primary"), // 'primary' | 'supporting' | 'duplicate_evidence'
    linkedBy: text("linked_by").notNull(), // 'manual' | 'auto' | 'import'
    confidenceScore: integer("confidence_score"),
    createdByMemberId: text("created_by_member_id").references(() => members.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.documentId, t.purchaseId] }),
    purchaseIdx: index("document_purchase_links_purchase_idx").on(t.purchaseId),
    relationCheck: check(
      "document_purchase_links_relation_check",
      sql`${t.relationKind} IN ('primary', 'supporting', 'duplicate_evidence')`,
    ),
    linkedByCheck: check("document_purchase_links_linked_by_check", sql`${t.linkedBy} IN ('manual', 'auto', 'import')`),
  }),
);

// 文件 ↔ 資產 多對多(例:保固文件同時涵蓋多台序號)。
export const documentAssetLinks = sqliteTable(
  "document_asset_links",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id),
    relationKind: text("relation_kind").notNull().default("supporting"), // 'primary' | 'supporting' | 'warranty' | 'manual'
    linkedBy: text("linked_by").notNull(),
    confidenceScore: integer("confidence_score"),
    createdByMemberId: text("created_by_member_id").references(() => members.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.documentId, t.assetId] }),
    assetIdx: index("document_asset_links_asset_idx").on(t.assetId),
    relationCheck: check(
      "document_asset_links_relation_check",
      sql`${t.relationKind} IN ('primary', 'supporting', 'warranty', 'manual')`,
    ),
    linkedByCheck: check("document_asset_links_linked_by_check", sql`${t.linkedBy} IN ('manual', 'auto', 'import')`),
  }),
);

// 單一文件的 OCR 擷取欄位明細,含來源證據(bbox/頁碼)與人工確認狀態 —— 人工確認過的欄位
// (isUserConfirmed = true)之後重跑演算法不可靜默覆蓋,規則實作在 apps/api 的 internal 路由。
export const documentExtractedFields = sqliteTable(
  "document_extracted_fields",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id),
    fieldKey: text("field_key").notNull(), // 例:invoiceNo、serial、wEnd
    label: text("label").notNull(), // 例:發票號碼、序號／IMEI、保固迄日
    value: text("value"),
    normalizedValue: text("normalized_value"),
    confidence: real("confidence"), // 0-100
    extractionSource: text("extraction_source").notNull(), // 'ocr' | 'qr' | 'ai_inference' | 'vendor_lookup' | 'user_input'
    sourceNote: text("source_note"), // 人類可讀說明,例:QR Code 解碼、OCR 第 1 頁標題區
    isMono: integer("is_mono", { mode: "boolean" }).notNull().default(false),
    pageNumber: integer("page_number"),
    bboxJson: text("bbox_json"),
    isUserConfirmed: integer("is_user_confirmed", { mode: "boolean" }).notNull().default(false),
    confirmedByMemberId: text("confirmed_by_member_id").references(() => members.id),
    confirmedAt: text("confirmed_at"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => ({
    docFieldIdx: uniqueIndex("document_extracted_fields_doc_field_idx").on(t.documentId, t.fieldKey),
    extractionSourceCheck: check(
      "document_extracted_fields_source_check",
      sql`${t.extractionSource} IN ('ocr', 'qr', 'ai_inference', 'vendor_lookup', 'user_input')`,
    ),
    confidenceCheck: check(
      "document_extracted_fields_confidence_check",
      sql`${t.confidence} IS NULL OR (${t.confidence} >= 0 AND ${t.confidence} <= 100)`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 文件處理工作(Cloudflare Workflow 實例的 D1 對應紀錄)與事件歷程
// ---------------------------------------------------------------------------
export const documentProcessingJobs = sqliteTable(
  "document_processing_jobs",
  {
    id: text("id").primaryKey(), // 對應 Cloudflare Workflow instance id
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id),
    workflowInstanceId: text("workflow_instance_id"),
    queueMessageId: text("queue_message_id"),
    currentStage: integer("current_stage").notNull().default(1),
    stageKey: text("stage_key").notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    status: text("status").notNull().default("queued"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    lockedAt: text("locked_at"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    nextRetryAt: text("next_retry_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    documentIdx: index("document_processing_jobs_document_idx").on(t.documentId),
    statusRetryIdx: index("document_processing_jobs_status_retry_idx").on(t.status, t.nextRetryAt, t.createdAt),
    stageCheck: check("document_processing_jobs_stage_check", sql`${t.currentStage} BETWEEN 1 AND 8`),
    statusCheck: check(
      "document_processing_jobs_status_check",
      sql`${t.status} IN ('queued', 'running', 'waiting_review', 'completed', 'failed', 'retry')`,
    ),
  }),
);

export const documentProcessingEvents = sqliteTable(
  "document_processing_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id")
      .notNull()
      .references(() => documentProcessingJobs.id),
    stageNumber: integer("stage_number").notNull(),
    stageKey: text("stage_key").notNull(),
    eventType: text("event_type").notNull(), // 'started' | 'completed' | 'skipped' | 'retry_scheduled' | 'failed'
    detailJson: text("detail_json"),
    occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    jobIdx: index("document_processing_events_job_idx").on(t.jobId),
    stageCheck: check("document_processing_events_stage_check", sql`${t.stageNumber} BETWEEN 1 AND 8`),
    eventTypeCheck: check(
      "document_processing_events_event_type_check",
      sql`${t.eventType} IN ('started', 'completed', 'skipped', 'retry_scheduled', 'failed')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 關聯候選 —— 落地存表(而非即時運算即丟棄),保留 algorithm_version 與人工決策,
// 財務/稽核系統需要留下「當時系統建議了什麼、人工選了什麼」的紀錄。
// ---------------------------------------------------------------------------
export const relationCandidates = sqliteTable(
  "relation_candidates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id),
    targetType: text("target_type").notNull(), // 'purchase' | 'asset' | 'document'
    targetId: text("target_id").notNull(),
    score: integer("score").notNull(), // min(rawScore, 100)
    rawScore: integer("raw_score").notNull(),
    reasonsJson: text("reasons_json").notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    decision: text("decision").notNull().default("pending"), // 'pending' | 'accepted' | 'rejected' | 'superseded'
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    decidedAt: text("decided_at"),
    decidedByMemberId: text("decided_by_member_id").references(() => members.id),
  },
  (t) => ({
    documentDecisionIdx: index("relation_candidates_document_decision_idx").on(t.documentId, t.decision, t.score),
    targetTypeCheck: check("relation_candidates_target_type_check", sql`${t.targetType} IN ('purchase', 'asset', 'document')`),
    scoreCheck: check("relation_candidates_score_check", sql`${t.score} BETWEEN 0 AND 100`),
    decisionCheck: check(
      "relation_candidates_decision_check",
      sql`${t.decision} IN ('pending', 'accepted', 'rejected', 'superseded')`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// 歸屬移轉 —— 規格 2.11。ownership_kind 不含 'transfer'(見檔頭說明)。
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
    impactJson: text("impact_json"), // 申請當下記錄預計受影響的 purchase/asset/document 清單
    requestedByMemberId: text("requested_by_member_id")
      .notNull()
      .references(() => members.id),
    approvedByMemberId: text("approved_by_member_id").references(() => members.id),
    status: text("status").notNull().default("pending"),
    decisionNote: text("decision_note"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    decidedAt: text("decided_at"),
  },
  (t) => ({
    targetIdx: index("transfers_target_idx").on(t.targetType, t.targetId),
    statusIdx: index("transfers_status_idx").on(t.status),
    targetTypeCheck: check("transfers_target_type_check", sql`${t.targetType} IN ('purchase', 'asset')`),
    fromOwnershipCheck: check(
      "transfers_from_ownership_check",
      sql`${t.fromOwnership} IN ('per', 'corp', 'advance', 'custody')`,
    ),
    toOwnershipCheck: check("transfers_to_ownership_check", sql`${t.toOwnership} IN ('per', 'corp', 'advance', 'custody')`),
    statusCheck: check("transfers_status_check", sql`${t.status} IN ('pending', 'approved', 'rejected', 'cancelled')`),
  }),
);

// ---------------------------------------------------------------------------
// 稽核日誌 / 近期動態
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
// 人類可讀 ID 流水號 —— 應用層 upsert+1(見 sequences.ts)
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
