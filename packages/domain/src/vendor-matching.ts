// 供應商主檔比對規則 —— 對應規格文件 2.6 節。
//
// 業務規則(設計稿原文,務必保留):
// OCR 辨識出的供應商,若未登記於本主檔(比對名稱、統一編號、或任一 OCR 別名,三者符合其一即算登記),
// 無論信心分數多高,一律強制送入待覆核,不會自動歸檔。此規則獨立生效,優先於分數門檻。

export interface VendorRecord {
  id: string;
  name: string;
  taxId?: string | null;
  aliases: string[];
}

export interface VendorMatchInput {
  nameRaw?: string;
  taxId?: string;
  /** OCR 額外辨識出的別名候選字串(例如店章上的其他寫法)。 */
  aliasCandidates?: string[];
}

export function findRegisteredVendor(input: VendorMatchInput, vendors: VendorRecord[]): VendorRecord | null {
  for (const v of vendors) {
    if (input.taxId && v.taxId && input.taxId === v.taxId) return v;
    if (input.nameRaw && v.name === input.nameRaw) return v;
    if (input.aliasCandidates?.some((a) => v.aliases.includes(a))) return v;
  }
  return null;
}

/** 未登記於主檔 → 強制送入待覆核,不受信心分數影響。 */
export function requiresForcedReview(matchedVendor: VendorRecord | null): boolean {
  return matchedVendor === null;
}
