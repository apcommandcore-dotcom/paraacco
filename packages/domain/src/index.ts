// @paraacco/domain
// 核心業務邏輯:關聯評分演算法、OCR 整體信心分數計算、供應商主檔比對規則、ID 格式、
// 文件處理管線階段定義。
// 對應規格文件(paraacco-integration/vaultlink-v2-design-spec-20260902.md)第 2、5 節。

export * from "./matching";
export * from "./confidence";
export * from "./vendor-matching";
export * from "./id-generator";
export * from "./pipeline";
