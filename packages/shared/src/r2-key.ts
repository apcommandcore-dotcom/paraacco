// R2 物件 key 命名規則 —— 對應規格文件缺口清單第 5 點,依 Perplexity 技術提案的檢討修正。
//
// v1 的問題:key 裡嵌入了 purchaseId(`{ownership}/{purchaseId 或 unlinked}/{documentId}/...`),
// 但實際流程是文件先上傳進「待處理」(此時通常還沒有 purchaseId),等人工在覆核畫面關聯到
// 採購案之後才會有 purchaseId —— 代表關聯當下 key 會需要改變,而 R2/S3 類物件儲存沒有真正
// 的 rename,只能整份複製再刪除舊物件,徒增複雜度也增加出錯機會。ownership 也有同樣問題:
// 移轉審核通過後 ownership 會變,key 又要跟著搬。
//
// v2 修正:key 只依賴文件自身「建立當下就固定不變」的識別資訊(documentId + 該檔案版本的
// versionId),完全不依賴後續才會確定的業務關聯(purchaseId/ownership)。哪個 purchase／
// ownership 現在對應這份文件,一律查 document_files/document_purchase_links 等資料庫欄位,
// 不是靠拆解物件 key 字串反推。
//
// versionId 由呼叫端(apps/document-worker)在建立 R2 物件「之前」先產生(建議用
// crypto.randomUUID()),不能用 document_files.id(DB 自增 id 要等 INSERT 之後才有值,但
// R2 上傳通常要先於這筆 metadata INSERT 完成)。

export type DocumentFileKind = "original" | "normalized_pdf" | "page_image" | "thumbnail" | "ocr_json";

export interface DocumentObjectKeyInput {
  /** DOC-YYYY-NNNNNN,文件上傳當下就已配號(見 id-generator.ts),不受後續關聯狀態影響。 */
  documentId: string;
  kind: DocumentFileKind;
  /** 呼叫端在上傳前先產生的穩定亂數 ID,例如 crypto.randomUUID()。 */
  versionId: string;
  fileName: string;
  /** kind = 'page_image' 時,用來讓同一個 versionId 底下的多頁圖片照順序排列。 */
  pageNumber?: number;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * 產生 R2 物件 key。回傳值要整個存進 document_files.r2Key(該欄位有 UNIQUE index),
 * 之後查詢/下載一律透過 document_files 資料列拿 key,不要在別處重新組字串。
 */
export function documentObjectKey(input: DocumentObjectKeyInput): string {
  const pageSegment = input.pageNumber != null ? `p${String(input.pageNumber).padStart(3, "0")}-` : "";
  return `documents/${input.documentId}/${input.kind}/${input.versionId}/${pageSegment}${sanitizeFileName(input.fileName)}`;
}
