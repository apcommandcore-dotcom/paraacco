// 文件處理管線階段定義 —— 對應規格文件 3.5.1 節的 8 步驟進度條,並對齊 schema v2 的
// document_processing_jobs.stageKey / documents.status。
//
// v1 的問題:stage key(queued/validated/ocr/extract/classify/match/vendor_check/
// review_or_archive)是隨意取的,跟 documents.status 的 CHECK 約束值對不起來,兩邊各寫
// 各的容易漂移。v2 改成:前 7 個階段的 key 直接等於處理過程中 documents.status 會經過的
// 值(queued → validating → ocr → extract → classifying → matching → vendor_check),
// 第 8 階段「decision」不是 documents.status 的合法值,而是這一步「做決定」的過程,結束後
// 會把 documents.status 轉成下列其中一個終態(由 relation 比對結果 + vendor 主檔比對結果
// + 是否偵測到重複文件共同決定):
//   - review    有候選但需要人工覆核(分數在 60–89,或到 90+ 但決標分差不足 15,或供應商
//               未登記強制人工核對 vendor_check)
//   - archived  高信心自動關聯成功、且供應商已登記,直接歸檔
//   - dup       比對到跟既有文件 sha256 相同,判定為重複上傳
//   - failed    處理過程發生無法重試的錯誤(例如檔案格式無法解析)
//   - ignored   人工在待覆核畫面選擇「忽略」不處理
// (retry 不是這裡決定的終態,是 document_processing_jobs.status='retry' 時,文件本身的
// documents.status 維持在失敗前那一步,等待下一次重試)

export interface PipelineStage {
  step: number;
  key: string;
  label: string;
}

export const PIPELINE_STAGES: PipelineStage[] = [
  { step: 1, key: "queued", label: "排隊中" },
  { step: 2, key: "validating", label: "格式與病毒檢查" },
  { step: 3, key: "ocr", label: "OCR 辨識" },
  { step: 4, key: "extract", label: "欄位擷取中" },
  { step: 5, key: "classifying", label: "分類中" },
  { step: 6, key: "matching", label: "關聯比對中" },
  { step: 7, key: "vendor_check", label: "供應商主檔比對" },
  { step: 8, key: "decision", label: "待人工覆核／自動歸檔判定" },
];

/** decision 階段結束後,documents.status 可能落到的終態(不含 retry,retry 維持在失敗前的階段)。 */
export const PIPELINE_TERMINAL_STATUSES = ["review", "archived", "dup", "failed", "ignored"] as const;
export type PipelineTerminalStatus = (typeof PIPELINE_TERMINAL_STATUSES)[number];

export function pipelineLabel(step: number): string {
  return PIPELINE_STAGES.find((s) => s.step === step)?.label ?? "未知階段";
}

export function pipelineStageByKey(key: string): PipelineStage | undefined {
  return PIPELINE_STAGES.find((s) => s.key === key);
}
