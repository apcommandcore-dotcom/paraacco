// 人類可讀 ID 格式 —— 對應規格文件各實體的 id 欄位範例(PUR-2026-000183 等)。
// 純格式化函式,實際的流水號遞增邏輯在 @paraacco/db(id_sequences 表,需要交易保護)。

export type IdEntity = "PUR" | "AST" | "DOC" | "TRF";

export function formatSequentialId(entity: IdEntity, year: number, seq: number): string {
  const padded = String(seq).padStart(6, "0");
  // 歸屬移轉申請單目前設計稿裡沒有年份(TRF-000021),其餘實體都是 {代碼}-{年}-{6碼}。
  if (entity === "TRF") return `TRF-${padded}`;
  return `${entity}-${year}-${padded}`;
}
