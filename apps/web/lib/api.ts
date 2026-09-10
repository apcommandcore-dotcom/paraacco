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
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRow {
  id: string;
  ownership: string;
  source: string;
  status: DocumentStatus;
  docTypeCode: string | null;
  docDate: string | null;
  invoiceNo: string | null;
  orderNo: string | null;
  serialNo: string | null;
  brand: string | null;
  model: string | null;
  amountCents: number | null;
  currency: string | null;
  vendorNameRaw: string | null;
  vendorId: string | null;
  ocrConfidence: number | null;
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
  summary: string;
  amountCents: number;
  currency: string;
  purchaseDate: string;
  status: string;
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

export type WarrantyType = "warranty" | "subscription";
export type RenewalCycle = "one_time" | "monthly" | "quarterly" | "yearly";
export type WarrantyStatus = "active" | "due_soon" | "expired";
export const WARRANTY_STATUS_LABELS: Record<WarrantyStatus, string> = { active: "使用中", due_soon: "即將到期", expired: "已過期" };

export interface WarrantyItem {
  id: string;
  entityType: string | null;
  entityId: string | null;
  ownership: OwnershipScope;
  name: string;
  type: WarrantyType;
  vendorName: string | null;
  startDate: string | null;
  endDate: string;
  renewalCycle: RenewalCycle;
  amountCents: number | null;
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
