// 文件處理管線階段 —— 對應規格文件 3.5.1 節的 8 步驟進度條與缺口清單第 2 點的建議定義。
// 這是規格文件明確標記為「需要外部協助補完」的部分,先給出一版可運作的預設定義,
// 之後可依 Gemini/Perplexity 或 document-worker 實際串接的 OCR 服務調整。

export interface PipelineStage {
  step: number;
  key: string;
  label: string;
}

export const PIPELINE_STAGES: PipelineStage[] = [
  { step: 1, key: "queued", label: "排隊中" },
  { step: 2, key: "validated", label: "格式與病毒檢查" },
  { step: 3, key: "ocr", label: "OCR 辨識" },
  { step: 4, key: "extract", label: "欄位擷取中" },
  { step: 5, key: "classify", label: "分類中" },
  { step: 6, key: "match", label: "關聯比對中" },
  { step: 7, key: "vendor_check", label: "供應商主檔比對" },
  { step: 8, key: "review_or_archive", label: "待人工覆核／自動歸檔判定" },
];

export function pipelineLabel(step: number): string {
  return PIPELINE_STAGES.find((s) => s.step === step)?.label ?? "未知階段";
}
