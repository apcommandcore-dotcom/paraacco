// 共用的 apps/api fetch 封裝 —— 統一帶 credentials: "include"(讓 Cloudflare Access 的
// session cookie 能跟著帶過去)跟 API_BASE。見 app/page.tsx 開頭註解:web/api 是不同子網域,
// 一律跨網域呼叫。
//
// Content-Type 故意用 text/plain,不是 application/json(2026-09-06 修正,見
// CODE_REPORT_post-golive-hardening_20260905.md 任務 7 的迴歸測試發現)——Cloudflare
// Access 保護整個網域,連 CORS 的 preflight OPTIONS 請求都會被攔下來要求登入;但瀏覽器規範
// preflight 請求本來就一定「不帶」cookie(不管實際請求是不是 credentials:"include"),
// 所以 Access 永遠會把這個沒帶登入 cookie 的 preflight 當成未登入,直接攔截、回應裡沒有
// Access-Control-Allow-Origin,整個請求就在 preflight 這關失敗,連 Worker 都還沒進去。
// text/plain 是 CORS「simple request」允許的 Content-Type 之一,瀏覽器會整個跳過
// preflight,直接送出帶 cookie 的正式請求——後端 Hono 的 c.req.json() 本來就只是把
// body 讀成文字再 JSON.parse(),完全不管 Content-Type header 寫什麼,所以這樣改不影響
// 後端解析。
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "https://acco-api.parallelserver.org";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: init?.body && !(init.body instanceof FormData) ? { "Content-Type": "text/plain", ...init.headers } : init?.headers,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// --- 資料型別(對照 apps/api 的回傳形狀,見 packages/db/src/schema.ts) ---

export type DocumentStatus =
  | "queued"
  | "validating"
  | "ocr"
  | "extract"
  | "classifying"
  | "matching"
  | "vendor_check"
  | "review"
  | "archived"
  | "failed"
  | "retry"
  | "dup"
  | "ignored";

export type ProcessingJobStatus = "queued" | "running" | "waiting_review" | "completed" | "failed" | "retry";

export interface ProcessingJob {
  id: string;
  documentId: string;
  currentStage: number;
  stageKey: string;
  status: ProcessingJobStatus;
  attemptCount: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

// 稽核日誌 —— 文件詳情頁「進階／稽核」區用(2026-09-16,v8 設計稿分層對齊)。對應
// packages/db/src/schema.ts 的 activityLog 表,entityType 固定 'document' 時查這份文件的
// 歸屬移轉/覆核/匯入紀錄,透過既有的 GET /api/activity?entityType=&entityId= 端點取得
// (不是新端點)。
export interface ActivityLogEntry {
  id: number;
  entityType: string;
  entityId: string;
  kind: string;
  text: string;
  actorMemberId: string | null;
  createdAt: string;
}

export interface DocumentRow {
  id: string;
  ownership: string;
  // true = 進件時由呼叫端(歷史回填)確認過歸屬,分類階段不會覆蓋(前端目前沒有畫面用到)。
  ownershipConfirmed: boolean;
  source: string;
  status: DocumentStatus;
  docTypeCode: string | null;
  docDate: string | null;
  // 單據/發票開立日期(2026-09-18,見 CODE_TASK_document-fields-additions_20260918.md 第 2
  // 節)—— 跟 docDate 分開,docDate 多日期同時出現時優先取繳費期限,invoiceDate 單純是單據
  // 開立日,排序請優先用這欄、null 時 fallback 用 docDate(還沒重新 OCR 過的舊文件)。
  invoiceDate: string | null;
  invoiceNo: string | null;
  orderNo: string | null;
  serialNo: string | null;
  brand: string | null;
  model: string | null;
  amountCents: number | null;
  currency: string | null;
  vendorNameRaw: string | null;
  /** 供應商主檔名稱(vendorId 對應;2026-09-29 起顯示用的「對象」一律用它,見 displayVendor())。 */
  vendorName?: string | null;
  /** matched | pending | taxid_unreadable(document_extracted_fields.vendor_status)。 */
  vendorStatus?: string | null;
  /** 所屬物件與角色(2026-09-29):primary = 主文件、supporting = 附件(attachmentRole 標類型)。 */
  purchaseId?: string | null;
  purchaseRelation?: "primary" | "supporting" | null;
  attachmentRole?: string | null;
  vendorId: string | null;
  ocrConfidence: number | null;
  // 使用者可編輯的顯示名稱(2026-09-18)—— 分類 pipeline 只在這欄還是 null 時,用 OCR
  // 擷取到的品名(itemName)當預設值填入(見 CODE_TASK_document-fields-additions_20260918.md
  // 第 1 節),已經有值不會被覆蓋;null 時前端要自己 fallback 顯示 vendorNameRaw 或 id,
  // 不能當作一定有值(舊文件、或 OCR 也沒擷取到品名時仍然是 null)。
  displayName: string | null;
  // 2026-09-28(migration 0009):NAS 原檔已歸檔到正式位置的時間、專案代碼(只做標記)。
  filedAt?: string | null;
  projectCode?: string | null;
  // 2026-09-28(CODE_TASK V1.04):'shared' = 共用(信用卡帳單/銀行對帳單)。documents.ownership 沒有這個值,
  // 存在擷取欄位 ownership_scope;列表 API 帶出來,詳情從 fields 取。
  ownershipScope?: string | null;
  createdAt: string;
  updatedAt: string;
  processingJob: ProcessingJob | null;
}

export interface ExtractedField {
  id: number;
  documentId: string;
  fieldKey: string;
  label: string;
  value: string | null;
  normalizedValue: string | null;
  confidence: number | null;
  extractionSource: string;
  sourceNote: string | null;
  isUserConfirmed: boolean;
  sortOrder: number;
}

export interface DocumentFile {
  id: number;
  documentId: string;
  kind: string;
  r2Key: string;
  originalFileName: string;
  mimeType: string;
  byteSize: number;
  isCurrent: boolean;
  sha256?: string | null;
  // 2026-09-28:'local' = 原始檔只留 NAS(r2Key 只是佔位值),位置是 localRoot + localPath。
  storage?: "r2" | "local";
  localPath?: string | null;
}

export interface MatchReason {
  label: string;
  points: number;
}

export interface RelationCandidate {
  id: number;
  documentId: string;
  targetType: "purchase" | "asset" | "document";
  targetId: string;
  score: number;
  rawScore: number;
  reasons: MatchReason[];
  decision: "pending" | "accepted" | "superseded" | "rejected";
}

export interface PurchaseRow {
  id: string;
  ownership: string;
  vendorNameRaw: string;
  invoiceNo?: string | null;
  orderNo?: string | null;
  summary: string;
  amountCents: number;
  currency: string;
  purchaseDate: string;
  status: string;
  // 2026-09-13 財務文件自動分類新增,見 EntityRow/ProjectRow。
  entityId: string | null;
  projectId: string | null;
}

export interface AssetRow {
  id: string;
  ownership: string;
  name: string;
  categoryId: string | null;
  brand: string | null;
  model: string | null;
  serialNo: string | null;
  acquiredDate: string | null;
  warrantyEndDate: string | null;
  vendorName: string | null;
  amountCents: number | null;
  currency: string | null;
  note: string | null;
  status: string;
}

export interface AssetDocumentLink {
  documentId: string;
  relationKind: string;
  docTypeCode: string | null;
  vendorNameRaw: string | null;
  status: string;
}

// 說明書 vs 憑證(2026-09-10 資產欄位對齊任務書任務 3)—— 沿用既有的 document_asset_links
// relationKind 欄位(schema 本來就允許 'manual' 這個值),不是新欄位。relationKind='manual'
// 代表「這份文件是說明書」,其餘值(primary/supporting/warranty)歸類為「憑證」。
export const MANUAL_RELATION_KIND = "manual";

// 範圍(2026-09-07 補完設計落差任務書任務 2)—— 沿用既有的 documents/purchases/assets
// ownership 欄位,不是新欄位,見 apps/api/src/routes/*.ts 的 ownership query param。
export type OwnershipScope = "per" | "corp" | "advance" | "custody";
export const OWNERSHIP_LABELS: Record<OwnershipScope, string> = {
  corp: "公司",
  per: "個人",
  advance: "代墊",
  custody: "代管",
};

export interface CountsResponse {
  inbox: number;
  pendingReview: number;
}

export type WarrantyType = "warranty" | "subscription" | "recurring_bill";
export const WARRANTY_TYPE_LABELS: Record<WarrantyType, string> = { warranty: "保固", subscription: "訂閱", recurring_bill: "定期繳費" };
export type RenewalCycle = "one_time" | "monthly" | "bimonthly" | "quarterly" | "semiannual" | "yearly";
export const RENEWAL_CYCLE_LABELS: Record<RenewalCycle, string> = {
  one_time: "一次性",
  monthly: "每月",
  bimonthly: "每兩個月",
  quarterly: "每季",
  semiannual: "每半年",
  yearly: "每年",
};
export type PaymentMethod = "auto_debit" | "credit_card" | "manual";
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = { auto_debit: "自動扣款", credit_card: "信用卡代繳", manual: "手動繳費" };
// 跟 packages/domain 的 WARRANTY_CATEGORIES 一致(API 層驗證用那一份)。
export const WARRANTY_CATEGORY_LABELS: Record<string, string> = {
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
  software: "軟體",
  membership: "會費",
  device: "硬體",
  other: "其他",
};
export type WarrantyStatus = "active" | "due_soon" | "expired";
export const WARRANTY_STATUS_LABELS: Record<WarrantyStatus, string> = { active: "使用中", due_soon: "即將到期", expired: "已過期" };

export interface WarrantyItem {
  id: string;
  entityType: string | null;
  entityId: string | null;
  ownership: OwnershipScope;
  name: string;
  type: WarrantyType;
  category: string | null;
  vendorName: string | null;
  startDate: string | null;
  endDate: string;
  renewalCycle: RenewalCycle;
  amountCents: number | null;
  paymentMethod: PaymentMethod | null;
  accountRef: string | null;
  currency: string | null;
  reminderDaysBefore: number;
  note: string | null;
  status: WarrantyStatus;
  createdAt: string;
  updatedAt: string;
}

export type NotificationType =
  | "weekly_review"
  | "monthly_review"
  | "inbox_stale"
  | "warranty_due"
  | "dup_candidate"
  | "pipeline_failed"
  | "transfer_submitted"
  | "transfer_decided";

export interface NotificationItem {
  id: number;
  type: NotificationType;
  title: string;
  message: string;
  entityType: string | null;
  entityId: string | null;
  severity: "info" | "warning" | "critical";
  createdAt: string;
  readAt: string | null;
}

export const STAGE_LABELS: Record<string, string> = {
  queued: "1・已排入",
  validating: "2・驗證中",
  ocr: "3・辨識中",
  extract: "4・擷取欄位",
  classifying: "5・分類中",
  matching: "6・比對關聯",
  vendor_check: "7・供應商檢核",
  decision: "8・決定歸檔",
};

// 財務文件自動分類(2026-09-13,見 paraacco-doc-classification-architecture-20260912.md)——
// entities/projects/statement_lines,跟既有的 ownership 維度正交(ownership 決定公司/個人,
// entity 決定哪一個法律主體)。
export interface EntityRow {
  id: string;
  name: string;
  taxId: string | null;
}

export interface ProjectRow {
  id: string;
  name: string;
  status: string;
  budgetAmountCents: number | null;
  currency: string | null;
  startDate: string | null;
  endDate: string | null;
}

export type ReconciliationStatus = "matched" | "suggested" | "unmatched";
export const RECONCILIATION_STATUS_LABELS: Record<ReconciliationStatus, string> = {
  matched: "已勾稽",
  suggested: "建議勾稽・待確認",
  unmatched: "未勾稽",
};

export interface StatementLineRow {
  id: number;
  entityId: string;
  sourceDocumentId: string;
  date: string;
  amountCents: number;
  description: string;
  reconciliationStatus: ReconciliationStatus;
  matchedPurchaseId: string | null;
  matchConfidence: number | null;
  matchNote: string | null;
  createdAt: string;
  matchedPurchaseSummary: string | null;
  matchedPurchaseVendor: string | null;
}

// 依標題瀏覽(2026-09-16,見 paraacco-browse-by-title-design-evaluation-20260916.md)——
// 分類 → 供應商兩層,category/vendor 本身不是新概念,既有 schema 早就有,這裡補前端型別。
export interface CategoryRow {
  id: string;
  ownershipScope: string;
  parentId: string | null;
  name: string;
}

export interface VendorRow {
  id: string;
  name: string;
  taxId: string | null;
  defaultOwnership: string;
  defaultCategoryId: string | null;
  aliases: string[];
}

// 同一案件關聯文件(document_case_links)—— 見 packages/db/src/schema.ts 的
// documentCaseLinks 表定義註解。
export interface CaseLinkDocument {
  caseId: string;
  documentId: string;
  role: string;
  linkedBy: string;
  docTypeCode: string | null;
  vendorNameRaw: string | null;
  docDate: string | null;
  status: string;
}

export interface CaseGroup {
  caseId: string;
  documents: CaseLinkDocument[];
}

export const CASE_LINK_ROLE_LABELS: Record<string, string> = {
  payment: "繳費單",
  reminder: "催繳(基數)",
  penalty: "催繳(滯納金)",
  enforcement: "行政執行",
  receipt: "收據",
  INV: "發票",
  WAR: "保證書",
  RET: "收據",
  DEL: "出貨單",
  ORD: "訂單",
  SUB: "訂閱/帳單",
  MAN: "說明書",
};

export const DOC_STATUS_LABELS: Record<DocumentStatus, string> = {
  queued: "已排入",
  validating: "驗證中",
  ocr: "辨識中",
  extract: "擷取中",
  classifying: "分類中",
  matching: "比對中",
  vendor_check: "供應商檢核",
  review: "待覆核",
  archived: "已歸檔",
  failed: "失敗",
  retry: "重試中",
  dup: "重複",
  ignored: "已略過",
};

// --- 定期帳單月份檢核(2026-09-28,apps/api/src/routes/recurring.ts)---

export type RecurringCadence = "monthly" | "bimonthly_odd" | "bimonthly_even" | "yearly";
export type CoverageStatus = "present" | "reminder_only" | "encrypted" | "not_required" | "missing";

export const CADENCE_LABELS: Record<RecurringCadence, string> = {
  monthly: "月",
  bimonthly_odd: "雙月(單數月)",
  bimonthly_even: "雙月(雙數月)",
  yearly: "年",
};

export const COVERAGE_STATUS_LABELS: Record<CoverageStatus, string> = {
  present: "有",
  reminder_only: "只有催繳",
  encrypted: "加密",
  not_required: "無需帳單",
  missing: "缺",
};

export interface RecurringSeriesRow {
  id: string;
  name: string;
  cadence: RecurringCadence;
  ownership: string | null;
  entityId: string | null;
  accountRef: string | null;
  startMonth: string;
  endMonth: string | null;
}

export interface CoverageCell {
  month: string;
  status: CoverageStatus;
  expected: boolean;
  documentIds: string[];
  reminderDocumentIds: string[];
  note: string | null;
}

export interface CoverageSeries extends RecurringSeriesRow {
  months: CoverageCell[];
  summary: { expected: number; present: number; reminderOnly: number; encrypted: number; notRequired: number; missing: number };
}

export interface CoverageResponse {
  from: string;
  to: string;
  series: CoverageSeries[];
}

export interface RecurringDocumentInfo {
  documentId: string;
  billingMonths: string[];
  billingMonthsConfirmed: boolean;
  recurringSeriesId: string | null;
  recurringSeriesConfirmed: boolean;
  projectCode: string | null;
  suggestion: { series: { seriesId: string; score: number } | null; billingMonths: string[] };
}

/** 文件歸屬顯示:ownership_scope=shared 顯示「共用」,否則照 ownership;未確認加註。只做顯示,不影響篩選。 */
export function documentOwnershipLabel(doc: { ownership: string; ownershipConfirmed?: boolean; ownershipScope?: string | null }): string {
  if (doc.ownershipScope === "shared") return "共用";
  const label = OWNERSHIP_LABELS[doc.ownership as OwnershipScope] ?? doc.ownership;
  return doc.ownershipConfirmed === false ? `${label}(未確認)` : label;
}

// ---------------------------------------------------------------------------
// 待建檔供應商(2026-09-29,CODE_TASK_vendor-name-from-taxid_20260929.md R-V3)——GET /api/vendors/pending
// ---------------------------------------------------------------------------
export type VendorTaxIdSource = "qr" | "printed" | "unreadable";
export const VENDOR_TAX_ID_SOURCE_LABELS: Record<VendorTaxIdSource, string> = { qr: "QR", printed: "印字", unreadable: "無法辨識" };

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

export interface PendingVendorsResponse {
  pending: PendingVendorGroup[];
  unreadable: UnreadableTaxIdDoc[];
}

/** 顯示用的「對象」(R-V1):有主檔就用主檔名稱;沒有才退回 OCR 店名並標「未建檔」(OCR 店名僅供參考)。 */
export function displayVendor(doc: { vendorName?: string | null; vendorNameRaw?: string | null }): { name: string; registered: boolean } {
  if (doc.vendorName) return { name: doc.vendorName, registered: true };
  return { name: doc.vendorNameRaw ?? "—", registered: false };
}

// ---------------------------------------------------------------------------
// 物件(採購案)= 一筆消費(2026-09-29,CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md)
// ---------------------------------------------------------------------------
export const ATTACHMENT_ROLE_LABELS: Record<string, string> = {
  DEL: "出貨單",
  RET: "收據",
  ORD: "訂單",
  SIGN: "簽單",
  MAN: "說明書",
  WAR: "保固單",
  PHOTO: "照片",
  OTHER: "其他",
};
export const ATTACHMENT_ROLES = Object.keys(ATTACHMENT_ROLE_LABELS);
export const DOC_KIND_LABELS: Record<string, string> = {
  invoice: "發票",
  receipt: "收據",
  delivery: "出貨單",
  order: "訂單",
  manual: "說明書",
  warranty: "保固書",
  other: "其他",
};
export const MERGE_RULE_LABELS: Record<number, string> = {
  1: "同一發票號碼(重複檔)",
  2: "訂單號/出貨單號相同,或印有發票號碼",
  3: "同賣方統編 + 同金額 + 7 天內",
  4: "統編缺漏,店名相近 + 同金額 + 同一天",
  5: "說明書/保固單:同品牌型號或序號",
};

export interface PurchaseItemRow {
  id: string;
  purchaseId: string;
  lineNo: number;
  name: string;
  quantity: number;
  unitPriceCents: number | null;
  amountCents: number;
  brand: string | null;
  model: string | null;
  serialNo: string | null;
  ownership: OwnershipScope | null;
  warrantyStartDate: string | null;
  warrantyEndDate: string | null;
  source: "invoice_line" | "manual" | "split";
  note: string | null;
  // 2026-10-01(V1.02 7.2、7.5)品項右鍵管理
  categoryId?: string | null;
  categorySource?: "manual" | "rule" | null;
  projectCode?: string | null;
  isAdvance?: boolean;
  advancePayee?: string | null;
  advanceSettledAt?: string | null;
  excludeFromReport?: boolean;
  excludeReason?: string | null;
  nameOriginal?: string | null;
}

export interface ItemCategory {
  id: string;
  name: string;
  code: string | null;
  parentId: string | null;
  accountTitle: string | null;
  defaultOwnership: OwnershipScope | null;
  isActive: boolean;
  sortOrder: number;
  color: string | null;
  usedCount?: number;
}

export interface AdvancePayee {
  id: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
}

export interface ItemRule {
  id: number;
  vendorTaxId: string;
  nameKeyword: string | null;
  categoryId: string | null;
  ownership: OwnershipScope | null;
  projectCode: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface AdvanceItem extends PurchaseItemRow {
  purchaseDate: string;
  vendorName: string | null;
  payeeName: string | null;
}

export interface ObjectDocument {
  documentId: string;
  relationKind: "primary" | "supporting";
  attachmentRole: string | null;
  purchaseItemId: string | null;
  kind: string;
  status: string | null;
  ownership: OwnershipScope | null;
  amountCents: number | null;
  invoiceNo: string | null;
  date: string | null;
  vendorName: string | null;
  vendorNameRaw: string | null;
  displayName: string | null;
  localPath: string | null;
}

export interface ObjectAttachment {
  id: number;
  purchaseId: string;
  purchaseItemId: string | null;
  kind: "video" | "photo" | "other";
  localPath: string;
  originalFileName: string | null;
  byteSize: number | null;
  note: string | null;
}

export interface ObjectDetail {
  purchase: PurchaseRow;
  primary: ObjectDocument | null;
  documents: ObjectDocument[];
  items: Array<PurchaseItemRow & { effectiveOwnership: OwnershipScope; documentIds: string[]; attachmentIds: number[] }>;
  attachments: ObjectAttachment[];
  flags: { mixedOwnership: boolean; itemAmountMismatch: boolean; mixedOwnershipWarning: boolean; cutoff: string; ownershipConflicts: string[] };
}

export interface MergeCandidate {
  rule: number;
  note: string;
  uncertain: boolean;
  duplicate: boolean;
  documentId: string;
  purchaseId: string | null;
  otherKind: string;
  otherOwnership: OwnershipScope;
  otherAmountCents: number | null;
  otherDate: string | null;
  otherVendorName: string | null;
  otherInvoiceNo: string | null;
  suggestedRole: string;
  itemLineNo: number | null;
  ownershipConflict: boolean;
}

export interface MergeCandidatesResponse {
  documentId: string;
  currentPurchaseId: string | null;
  candidates: MergeCandidate[];
}

export interface ReportRowItem {
  id: string;
  lineNo: number;
  name: string;
  quantity: number;
  unitPriceCents: number | null;
  amountCents: number;
  ownership: string | null;
  effectiveOwnership: string;
  attachmentCount: number;
  // 2026-10-01(V1.02 7.5)
  purchaseId?: string;
  categoryId?: string | null;
  categorySource?: "manual" | "rule" | null;
  projectCode?: string | null;
  isAdvance?: boolean;
  advancePayee?: string | null;
  advanceSettledAt?: string | null;
  excludeFromReport?: boolean;
  excludeReason?: string | null;
  nameOriginal?: string | null;
}

export interface ReportRow {
  key: string;
  purchaseId: string | null;
  primaryDocumentId: string;
  date: string | null;
  vendor: string;
  vendorRegistered: boolean;
  invoiceNo: string | null;
  ownership: string;
  status: string;
  amountCents: number | null;
  segment: "recurring" | "general";
  recurringSeriesId: string | null;
  attachmentSummary: string;
  attachmentDocumentIds: string[];
  items: ReportRowItem[];
  mixedOwnership: boolean;
  itemAmountMismatch: boolean;
  needsConfirm: boolean;
  ownershipSplit: Record<string, number>;
}

export interface ReportSubtotals {
  byOwnership: Record<string, { count: number; cents: number }>;
  count: number;
  cents: number;
}

export interface MonthlyReportResponse {
  month: string;
  recurring: { rows: ReportRow[]; subtotals: ReportSubtotals };
  general: { rows: ReportRow[]; subtotals: ReportSubtotals };
  total: ReportSubtotals;
  pendingConfirm: string[];
  missingAmount: number;
  noDate: number;
  cutoff: string;
  // 2026-10-01(V1.02 7.5)依費用類別/專案小計("__none__" = 未分類/不屬於專案);代墊、不列帳分列
  byCategory?: Record<string, number>;
  byProject?: Record<string, number>;
  advanceItems?: ReportItemListEntry[];
  excludedItems?: ReportItemListEntry[];
  categoryNames?: Record<string, string>;
  payeeNames?: Record<string, string>;
}

export interface ReportItemListEntry {
  itemId: string;
  purchaseId: string;
  primaryDocumentId: string;
  date: string | null;
  vendor: string;
  name: string;
  amountCents: number;
  advancePayee?: string | null;
  reason?: string | null;
}

export const UNCATEGORIZED_KEY = "__none__";

