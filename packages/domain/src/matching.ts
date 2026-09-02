// 關聯評分演算法 —— 對應規格文件(VaultLink v2 design spec)2.8 節,並依 Perplexity 技術提案
// 7.2 節的檢討修正 v1 版本兩個實際問題:
//   1. 原本純加總分數沒有上限,理論上可能超過 100 分,對外顯示/門檻判斷語意不清楚 —— 現在
//      拆成 rawScore(未封頂,供稽核/除錯用)與 score(封頂 100,供門檻判斷用)。
//   2. 原本沒有「強識別欄位衝突」的淘汰機制:如果文件與候選物件都有發票號/序號/訂單號,
//      但值不一樣,這是很強的負面證據(代表根本是不同筆交易),應該直接讓這個候選物件
//      不合格,而不是繼續累加供應商/金額/日期等較弱的正面訊號、甚至湊到自動關聯門檻。
//
// 門檻(規格文件原文):90 分以上自動關聯;60–89 分送入待覆核由人工選擇;60 分以下不列入候選。
//
// 新增的「決標」規則(tie-break,見 resolveAutoLink()):就算最高分候選達到自動關聯門檻,
// 如果第二名分數跟它差距小於 15 分,代表系統無法有信心地判斷唯一對應對象,一樣要降級成
// 送人工覆核,不能自動關聯 —— 避免兩筆條件很像的採購案其中一筆被誤判關聯。

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
  /** 未封頂的加總分數,保留給稽核/除錯用,不要拿來跟門檻比較。 */
  rawScore: number;
  /** 封頂在 0–100 的分數,門檻判斷一律用這個欄位。淘汰(disqualified)時強制為 0。 */
  score: number;
  reasons: MatchReason[];
  /** 是否命中至少一個強識別欄位(訂單號／序號／發票號其中之一完全相同)。 */
  hardMatch: boolean;
  /** 是否因為強識別欄位衝突被淘汰(值不一樣,不是缺值)。 */
  disqualified: boolean;
  disqualifyReason?: string;
  autoLink: boolean;
  suggestReview: boolean;
}

export const AUTO_LINK_THRESHOLD = 90;
export const REVIEW_THRESHOLD = 60;
/** 決標門檻:最高分候選要贏第二名至少這個分數差,才允許自動關聯,否則降級送人工覆核。 */
export const TIE_BREAK_MARGIN = 15;
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

/**
 * 強識別欄位衝突偵測:雙方都「有值」但「值不一樣」才算衝突 —— 其中一邊沒有值(可能只是
 * 該來源沒擷取到這個欄位)不算衝突,不能因為缺值就淘汰候選物件。
 */
function detectConflict(doc: MatchableFields, f: MatchableFields): string | null {
  if (doc.invoiceNo && f.invoiceNo && doc.invoiceNo !== f.invoiceNo) {
    return "發票號不一致";
  }
  if (doc.serialNo && f.serialNo && doc.serialNo !== f.serialNo) {
    return "序號／IMEI 不一致";
  }
  if (doc.orderNo && f.orderNo && doc.orderNo !== f.orderNo) {
    return "訂單號不一致";
  }
  return null;
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

  const rawScore = reasons.reduce((sum, r) => sum + r.points, 0);
  const disqualifyReason = detectConflict(doc, f) ?? undefined;
  const disqualified = disqualifyReason !== undefined;
  const score = disqualified ? 0 : Math.min(rawScore, 100);
  const hardMatch = reasons.some((r) => r.points >= 90);

  return {
    kind: candidate.kind,
    id: candidate.id,
    rawScore,
    score,
    reasons,
    hardMatch,
    disqualified,
    disqualifyReason,
    autoLink: !disqualified && score >= AUTO_LINK_THRESHOLD,
    suggestReview: !disqualified && score >= REVIEW_THRESHOLD && score < AUTO_LINK_THRESHOLD,
  };
}

/**
 * 對一批候選物件評分,留下未淘汰、達到覆核門檻(60 分)以上的,依分數由高到低排序。
 * 被淘汰(disqualified)的候選物件即使加總分數很高也不列入,避免人工覆核清單被誤導。
 */
export function rankCandidates(doc: MatchableFields, candidates: MatchCandidateInput[]): MatchResult[] {
  return candidates
    .map((c) => scoreCandidate(doc, c))
    .filter((r) => !r.disqualified && r.score >= REVIEW_THRESHOLD)
    .sort((a, b) => b.score - a.score);
}

/**
 * 決定是否可以自動關聯:取 rankCandidates() 排序後的結果,只有在最高分候選達到自動關聯
 * 門檻、且贏過第二名至少 TIE_BREAK_MARGIN 分時才回傳該候選物件;否則回傳 null,代表就算
 * 有候選物件分數達標,也因為無法唯一判斷而必須送人工覆核(仍會出現在 relation_candidates
 * 清單裡讓人工挑選,只是不能由系統自動決定)。
 */
export function resolveAutoLink(ranked: MatchResult[]): MatchResult | null {
  const [top, second] = ranked;
  if (!top || !top.autoLink) return null;
  if (second && top.score - second.score < TIE_BREAK_MARGIN) return null;
  return top;
}
