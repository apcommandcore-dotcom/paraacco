// 財務文件自動分類 —— 對應 paraacco-doc-classification-architecture-20260912.md 第 3 節、
// paraacco-code-handoff-package-20260913.md 第 2、3 節(entities/projects schema、Gemini
// 分類輸出的命名/歸屬規則)。
//
// 顯示檔名(documents.display_name)由這裡的純函式依固定規則組出來,不信任 Gemini 自己組
// 的字串 —— 組成規則(見 buildDisplayName())是明確、決定性的,程式碼組比較穩定、可測試,
// 不需要每次都靠模型排版正確。scope → ownership/entity/project 的映射同理,獨立於
// OCR provider 之外,方便單元測試,也方便日後 entities/projects 清單異動時只改這一個檔案。

export type OwnershipKind = "per" | "corp" | "advance" | "custody";

export interface ScopeResolution {
  ownership: OwnershipKind;
  entityId: string | null;
  projectId: string | null;
  /** true 代表這個範圍判斷本身就不夠篤定,不管信心分數多高都要強制送人工覆核。 */
  forceReview: boolean;
}

/**
 * 範圍碼 → (ownership, entityId, projectId) 映射。
 * 目前已知的 entities 只有 2 個(ap/studio,見 packages/db 的 entities 種子資料),
 * PROJ-{code} 的 code 直接沿用 Gemini 判讀出的專案代碼,不在這裡驗證是否存在於 projects
 * 表 —— 專案代碼查無對應 project 時,由呼叫端(internal/documents classify 路由)决定要
 * 忽略還是連同送審,這裡只負責純粹的規則映射。
 */
export function resolveScope(rawScope: string | undefined): ScopeResolution {
  const scope = (rawScope ?? "").trim();

  if (scope === "CORP-AP") return { ownership: "corp", entityId: "ap", projectId: null, forceReview: false };
  if (scope === "CORP-STUDIO") return { ownership: "corp", entityId: "studio", projectId: null, forceReview: false };
  if (scope === "PERS") return { ownership: "per", entityId: null, projectId: null, forceReview: false };
  if (scope.startsWith("PROJ-")) {
    const projectId = scope.slice("PROJ-".length).trim();
    return { ownership: "corp", entityId: null, projectId: projectId || null, forceReview: !projectId };
  }
  if (scope === "CORP-PERS") {
    // 公司/個人跨界只是建議標籤,不是最終判定,對應既有 ownership 的 'advance'(公司代墊)
    // 語意最接近,但一律強制送人工覆核決定實際歸屬。
    return { ownership: "advance", entityId: null, projectId: null, forceReview: true };
  }
  // '待確認'或任何無法辨識的值一律視為待確認,強制人工覆核。ownership 先給 'corp' 佔位
  // (目前批次進件來源都是公司財務文件),人工覆核時再自行修正成正確的 ownership。
  return { ownership: "corp", entityId: null, projectId: null, forceReview: true };
}

/** 顯示檔名的類型碼固定字典 —— 只用於組 display_name,跟 documents.doc_type_code(結構性,
 * 用於關聯/CHECK 約束)是兩個獨立的分類概念,新類型出現時挑最接近的碼,不要無限擴充。 */
export const FINANCE_DOC_TYPE_CODES = [
  "INV",
  "RCT",
  "INS",
  "TAX",
  "UTIL",
  "TEL",
  "BANK",
  "CC",
  "REPAIR",
  "QUOTE",
  "LOAN",
  "GOV",
  "DUES",
  "ADMIN",
  "REFUND",
  "INCOME",
  "TRAVEL",
  "MED",
] as const;
export type FinanceDocTypeCode = (typeof FINANCE_DOC_TYPE_CODES)[number];

export function isFinanceDocTypeCode(value: string | undefined): value is FinanceDocTypeCode {
  return typeof value === "string" && (FINANCE_DOC_TYPE_CODES as readonly string[]).includes(value);
}

/** 對象名稱長度限制 20 字內,超過從中間截斷保留頭尾(命名規則 3.1)。 */
export function truncateCounterparty(name: string, maxLen = 20): string {
  if (name.length <= maxLen) return name;
  const headLen = Math.ceil((maxLen - 1) / 2);
  const tailLen = maxLen - 1 - headLen;
  return `${name.slice(0, headLen)}…${name.slice(name.length - tailLen)}`;
}

export interface DisplayNameInput {
  /** YYYYMMDD,查無則留空(組出來的字串會是「待確認」)。 */
  date?: string;
  scope: string;
  docType?: string;
  counterparty?: string;
  amountCents?: number;
}

/** {日期}_{範圍碼}_{類型碼}_{對象}_{金額},見命名規則 3.1。 */
export function buildDisplayName(input: DisplayNameInput): string {
  const date = input.date && /^\d{8}$/.test(input.date) ? input.date : "待確認";
  const docType = isFinanceDocTypeCode(input.docType) ? input.docType : "待確認";
  const counterparty = input.counterparty ? truncateCounterparty(input.counterparty) : "待確認";
  const amount =
    input.amountCents === undefined || input.amountCents === null ? "待確認" : String(Math.trunc(input.amountCents / 100));
  return [date, input.scope, docType, counterparty, amount].join("_");
}

export interface ClassificationInput {
  scope?: string;
  financeDocType?: string;
  counterparty?: string;
  /** YYYY-MM-DD(既有 docDate 欄位格式)。 */
  docDate?: string;
  amountCents?: number;
  classificationConfidence?: "high" | "medium" | "low";
}

export interface ClassificationOutcome extends ScopeResolution {
  displayName: string;
}

/**
 * 整合 resolveScope() + buildDisplayName() 的入口 —— 金額無法辨識或分類信心低,不管
 * Gemini 判斷出什麼範圍碼,一律降級成「待確認」強制送人工覆核(命名規則 3.1、3.2)。
 */
export function classifyDocument(input: ClassificationInput): ClassificationOutcome {
  const amountMissing = input.amountCents === undefined || input.amountCents === null;
  const lowConfidence = input.classificationConfidence === "low";
  const effectiveScope = amountMissing || lowConfidence ? "待確認" : (input.scope ?? "待確認");

  const resolution = resolveScope(effectiveScope);
  const forceReview = resolution.forceReview || amountMissing || lowConfidence;

  const displayName = buildDisplayName({
    date: input.docDate?.replaceAll("-", ""),
    scope: effectiveScope,
    docType: input.financeDocType,
    counterparty: input.counterparty,
    amountCents: input.amountCents,
  });

  return { ...resolution, forceReview, displayName };
}
