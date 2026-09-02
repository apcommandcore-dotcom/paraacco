// R2 物件 key 命名規則 —— 對應規格文件缺口清單第 5 點。
// 慣例:{ownership}/{purchaseId 或 unlinked}/{documentId}/{fileName}
// 縮圖與原始檔放在同一份文件的目錄下,固定檔名 thumb.webp,方便前端不用另外查表就能拼出縮圖網址。

export interface R2KeyInput {
  /** 'per' | 'corp' | 'advance' | 'custody' | 'transfer' */
  ownership: string;
  purchaseId?: string | null;
  documentId: string;
  fileName: string;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function documentObjectKey(input: R2KeyInput): string {
  const purchaseSegment = input.purchaseId || "unlinked";
  return `${input.ownership}/${purchaseSegment}/${input.documentId}/${sanitizeFileName(input.fileName)}`;
}

export function documentThumbnailKey(input: Omit<R2KeyInput, "fileName">): string {
  const purchaseSegment = input.purchaseId || "unlinked";
  return `${input.ownership}/${purchaseSegment}/${input.documentId}/thumb.webp`;
}
