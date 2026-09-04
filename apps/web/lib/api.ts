// 共用的 apps/api fetch 封裝 —— 統一帶 credentials: "include"(讓 Cloudflare Access 的
// session cookie 能跟著帶過去)跟 API_BASE。見 app/page.tsx 開頭註解:web/api 是不同子網域,
// 一律跨網域呼叫。

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
    headers: init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
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

export interface RelationCandidate {
  id: number;
  documentId: string;
  targetType: "purchase" | "asset" | "document";
  targetId: string;
  score: number;
  rawScore: number;
  reasons: unknown[];
  decision: "pending" | "accepted" | "superseded" | "rejected";
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
