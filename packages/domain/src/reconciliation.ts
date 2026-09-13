// 憑證 × 對帳單自動勾稽 —— 對應 paraacco-doc-classification-architecture-20260912.md 第 5
// 節、paraacco-code-handoff-package-20260913_3.md 第 4 節。純函式,不碰 DB/OCR,方便單獨
// 測試比對邏輯本身對不對。
//
// 三輪比對規則:
//   1. 金額完全相符 + 日期在容許區間(±3 天)+ 供應商名稱相似度夠高 → matched。
//   2. 金額相符但日期/名稱對不上 → suggested(待人工確認;架構文件說這一輪要「交給 Gemini
//      做語意比對輔助判斷」,但語意比對需要即時呼叫 LLM,不是這裡的純函式能做的事——這裡先
//      用字串層級的粗略相似度分數當 suggested 的 confidence,真正的語意判斷留給人工在 Review
//      畫面確認,不是自動決標)。
//   3. 沒有任何金額相符的候選 → unmatched。

export interface StatementLineForMatching {
  amountCents: number;
  /** YYYY-MM-DD */
  date: string;
}

export interface PurchaseCandidateForMatching {
  id: string;
  amountCents: number;
  /** YYYY-MM-DD */
  purchaseDate: string;
  vendorNameRaw: string;
}

export type ReconciliationStatus = "matched" | "suggested" | "unmatched";

export interface ReconciliationResult {
  status: ReconciliationStatus;
  purchaseId: string | null;
  /** 0-100,unmatched 時為 null。 */
  confidence: number | null;
  note: string;
}

const DATE_TOLERANCE_DAYS = 3;
const NAME_SIMILARITY_MATCH_THRESHOLD = 0.6;

function daysBetween(a: string, b: string): number {
  const diffMs = Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime());
  return diffMs / (24 * 60 * 60 * 1000);
}

/**
 * 字串層級的粗略相似度(0-1)——正規化後完全相等或互相包含給高分,否則用共同字元比例
 * 粗估。中文商家名稱常見前後綴差異(股份有限公司/有限公司/分店名稱等),不追求語言學上
 * 嚴謹的比對,只用來決定「像不像到可以自動決標」,真正模糊的情況本來就該進 suggested
 * 讓人工判斷,不是靠這個函式解決語意問題。
 */
export function nameSimilarity(a: string, b: string): number {
  const normalize = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.8;

  const setA = new Set(na);
  const setB = new Set(nb);
  const common = [...setA].filter((ch) => setB.has(ch)).length;
  return common / Math.max(setA.size, setB.size);
}

/** 從候選採購案裡找出比對結果,candidates 應該先由呼叫端篩過同一個 entity 的範圍。 */
export function matchStatementLine(
  line: StatementLineForMatching,
  description: string,
  candidates: PurchaseCandidateForMatching[],
): ReconciliationResult {
  const amountMatches = candidates.filter((p) => p.amountCents === line.amountCents);
  if (amountMatches.length === 0) {
    return { status: "unmatched", purchaseId: null, confidence: null, note: "沒有金額相符的採購案" };
  }

  // 金額相符的候選裡,取日期最接近的那一筆當代表——日期差距是比名稱相似度更可靠的次要
  // 篩選條件(對帳單明細列通常是扣款日,跟採購日期本來就該很接近)。
  let best = amountMatches[0];
  let bestDateDiff = daysBetween(line.date, best.purchaseDate);
  for (const p of amountMatches.slice(1)) {
    const diff = daysBetween(line.date, p.purchaseDate);
    if (diff < bestDateDiff) {
      best = p;
      bestDateDiff = diff;
    }
  }

  const similarity = nameSimilarity(description, best.vendorNameRaw);

  if (bestDateDiff <= DATE_TOLERANCE_DAYS && similarity >= NAME_SIMILARITY_MATCH_THRESHOLD) {
    return {
      status: "matched",
      purchaseId: best.id,
      confidence: 95,
      note: `金額相符,日期相差 ${Math.round(bestDateDiff)} 天,供應商名稱相似`,
    };
  }

  const confidence = Math.round(similarity * 60 + Math.max(0, 1 - bestDateDiff / 30) * 40);
  return {
    status: "suggested",
    purchaseId: best.id,
    confidence,
    note: `金額相符,但日期相差 ${Math.round(bestDateDiff)} 天或供應商名稱不夠相似,建議人工確認`,
  };
}
