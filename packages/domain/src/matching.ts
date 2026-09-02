// 關聯評分演算法 —— 對應規格文件(VaultLink v2 design spec)2.8 節。
// 用途:一份新文件(OCR 擷取完成)要不要自動關聯到既有的採購案／資產／文件,
// 或者只是列成候選讓人工在待覆核畫面挑選。
//
// 門檻(規格文件原文):90 分以上自動關聯;60–89 分送入待覆核由人工選擇;60 分以下不列入候選。

export type MatchCandidateKind = "purchase" | "asset" | "document";

export interface MatchableFields {
  orderNo?: string;
  serialNo?: string;
  invoiceNo?: string;
  brand?: string;
  model?: string;
  vendorId?: string;
  vendorNameRaw?: string;
  amountCents?: number;
  /** ISO 日期字串 YYYY-MM-DD */
  date?: string;
}

export interface MatchCandidateInput {
  kind: MatchCandidateKind;
  id: string;
  fields: MatchableFields;
}

export interface MatchReason {
  label: string;
  points: number;
}

export interface MatchResult {
  kind: MatchCandidateKind;
  id: string;
  score: number;
  reasons: MatchReason[];
  autoLink: boolean;
  suggestReview: boolean;
}

export const AUTO_LINK_THRESHOLD = 90;
export const REVIEW_THRESHOLD = 60;
const DATE_WINDOW_DAYS = 14;

function daysBetween(a: string, b: string): number | null {
  const da = new Date(a);
  const db = new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return null;
  return Math.abs((da.getTime() - db.getTime()) / 86_400_000);
}

/** 供應商是否相同:優先比對已登記的 vendorId,退而比對原始字串。 */
function vendorMatches(a: MatchableFields, b: MatchableFields): boolean {
  if (a.vendorId && b.vendorId) return a.vendorId === b.vendorId;
  if (a.vendorNameRaw && b.vendorNameRaw) return a.vendorNameRaw === b.vendorNameRaw;
  return false;
}

export function scoreCandidate(doc: MatchableFields, candidate: MatchCandidateInput): MatchResult {
  const f = candidate.fields;
  const reasons: MatchReason[] = [];

  if (doc.orderNo && f.orderNo && doc.orderNo === f.orderNo) {
    reasons.push({ label: "訂單號相同", points: 100 });
  }
  if (doc.serialNo && f.serialNo && doc.serialNo === f.serialNo) {
    reasons.push({ label: "序號／IMEI 相同", points: 100 });
  }
  if (doc.invoiceNo && f.invoiceNo && doc.invoiceNo === f.invoiceNo) {
    reasons.push({ label: "發票號相同", points: 90 });
  }
  if (doc.brand && f.brand && doc.model && f.model && doc.brand === f.brand && doc.model === f.model) {
    reasons.push({ label: "品牌型號相同", points: 30 });
  }
  if (vendorMatches(doc, f)) {
    reasons.push({ label: "供應商相同", points: 20 });
  }
  if (doc.amountCents != null && f.amountCents != null && doc.amountCents === f.amountCents) {
    reasons.push({ label: "金額相同", points: 20 });
  }
  if (doc.date && f.date) {
    const diff = daysBetween(doc.date, f.date);
    if (diff !== null && diff <= DATE_WINDOW_DAYS) {
      reasons.push({ label: `日期差 ${Math.round(diff)} 天`, points: 15 });
    }
  }

  const score = reasons.reduce((sum, r) => sum + r.points, 0);
  return {
    kind: candidate.kind,
    id: candidate.id,
    score,
    reasons,
    autoLink: score >= AUTO_LINK_THRESHOLD,
    suggestReview: score >= REVIEW_THRESHOLD && score < AUTO_LINK_THRESHOLD,
  };
}

/** 對一批候選物件評分,只留下達到覆核門檻(60 分)以上的,依分數由高到低排序。 */
export function rankCandidates(doc: MatchableFields, candidates: MatchCandidateInput[]): MatchResult[] {
  return candidates
    .map((c) => scoreCandidate(doc, c))
    .filter((r) => r.score >= REVIEW_THRESHOLD)
    .sort((a, b) => b.score - a.score);
}
