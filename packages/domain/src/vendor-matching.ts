// 供應商主檔比對規則 —— 對應規格文件 2.6 節。
//
// 業務規則(設計稿原文,務必保留):
// OCR 辨識出的供應商,若未登記於本主檔,無論信心分數多高,一律強制送入待覆核,不會自動歸檔。
// 此規則獨立生效,優先於分數門檻。
//
// 2026-09-29(CODE_TASK_vendor-name-from-taxid_20260929.md R-V1、R-V2)——比對改成「只看賣方統編」:
//   - 觸發案例 DOC-2026-000061:發票上方 logo 字被 OCR 讀成「展騰企業社」,主檔登記是「展蝶企業社」
//     (統編 82066492)。店名/別名比對會被字型誤導,統編有檢查碼、QR Code 內容固定,才是可靠依據。
//   - vendorNameRaw(OCR 店名)照舊存,只供人工參考,不參與比對、不參與命名。原本的
//     findRegisteredVendor()(名稱/統編/別名三者符合其一)已移除。
//   - 賣方統編來源優先順序:電子發票左側 QR Code > 票面「賣方」欄印字;兩者都讀得到但不一致時以 QR 為準、
//     在 notes 註記。統編須通過 isValidTaxId() 檢查碼,讀不到或檢查碼錯誤視同未建檔(列清單註明「統編無法辨識」)。
//   - 不自動新增供應商,建檔由 Theo 在「管理 → 供應商與分類」自己做。

import { isValidTaxId, normalizeTaxId } from "./tax-id";

export interface VendorRecord {
  id: string;
  name: string;
  taxId?: string | null;
}

/** 統編來源:QR Code、票面印字、無法辨識(讀不到或檢查碼錯誤)。 */
export type VendorTaxIdSource = "qr" | "printed" | "unreadable";

export const VENDOR_TAX_ID_SOURCE_LABELS: Record<VendorTaxIdSource, string> = {
  qr: "QR",
  printed: "印字",
  unreadable: "無法辨識",
};

/** 文件的供應商比對狀態(存在 document_extracted_fields.vendor_status):
 *  matched = 統編已建檔、vendorId 已指向主檔;pending = 統編有效但未建檔;taxid_unreadable = 統編讀不到或檢查碼錯誤。
 *  documents.status 的 CHECK 沒有 vendor_pending(要加就得重建 documents 表,D1 做不到,見 schema.ts source 欄位註解),
 *  所以存成欄位,文件本身維持 review。 */
export type VendorStatus = "matched" | "pending" | "taxid_unreadable";

export const VENDOR_STATUS_FIELD_KEY = "vendor_status";
export const VENDOR_TAX_ID_FIELD_KEY = "vendorTaxId";
export const VENDOR_TAX_ID_SOURCE_FIELD_KEY = "vendorTaxIdSource";
export const VENDOR_TAX_ID_QR_FIELD_KEY = "vendorTaxIdQr";
export const VENDOR_TAX_ID_PRINTED_FIELD_KEY = "vendorTaxIdPrinted";
export const VENDOR_TAX_ID_NOTE_FIELD_KEY = "vendorTaxIdNote";

export interface VendorTaxIdInput {
  /** 電子發票左側 QR Code 解碼出的賣方統編。 */
  qr?: string | null;
  /** 票面「賣方」欄印字。 */
  printed?: string | null;
  /** 舊資料只有 vendorTaxId 一個欄位、沒標來源時。視為印字(SPEC V1.03 以前都是讀票面)。 */
  legacy?: string | null;
  /** 舊資料若已標過來源(vendorTaxIdSource),沿用。 */
  legacySource?: string | null;
}

export interface VendorTaxIdResolution {
  /** 通過檢查碼的 8 碼統編;讀不到或檢查碼錯誤時 null。 */
  taxId: string | null;
  source: VendorTaxIdSource;
  /** 讀到但檢查碼錯誤的原始值(列清單時顯示用)。 */
  rawInvalid: string | null;
  /** 需要寫進 notes 的註記(QR 與印字不一致、QR 檢查碼錯誤改用印字、統編無法辨識),沒有則 null。 */
  note: string | null;
}

function clean(v: string | null | undefined): string | null {
  const s = v == null ? "" : normalizeTaxId(String(v)).trim();
  return s ? s : null;
}

/** R-V2 1–2:依 QR > 印字 決定賣方統編,驗證檢查碼,不一致時以 QR 為準並註記。 */
export function resolveVendorTaxId(input: VendorTaxIdInput): VendorTaxIdResolution {
  const qr = clean(input.qr);
  const printed = clean(input.printed);
  const legacy = clean(input.legacy);
  const qrValid = !!qr && isValidTaxId(qr);
  const printedValid = !!printed && isValidTaxId(printed);

  if (qrValid) {
    const note = printed && printed !== qr ? `賣方統編 QR(${qr})與印字(${printed})不一致,以 QR 為準` : null;
    return { taxId: qr, source: "qr", rawInvalid: null, note };
  }
  if (printedValid) {
    const note = qr ? `QR 賣方統編 ${qr} 檢查碼錯誤,改用印字 ${printed}` : null;
    return { taxId: printed, source: "printed", rawInvalid: null, note };
  }
  if (!qr && !printed && legacy && isValidTaxId(legacy)) {
    const src = input.legacySource === "qr" || input.legacySource === "printed" ? input.legacySource : "printed";
    return { taxId: legacy, source: src, rawInvalid: null, note: null };
  }
  const raw = qr ?? printed ?? legacy;
  return {
    taxId: null,
    source: "unreadable",
    rawInvalid: raw,
    note: raw ? `賣方統編 ${raw} 檢查碼錯誤,統編無法辨識` : "讀不到賣方統編,統編無法辨識",
  };
}

/** R-V2 3:只用統編查主檔。名稱、別名一律不比對(R-V1)。 */
export function findVendorByTaxId<T extends VendorRecord>(taxId: string | null | undefined, vendors: T[]): T | null {
  const id = clean(taxId);
  if (!id || !isValidTaxId(id)) return null;
  return vendors.find((v) => v.taxId === id) ?? null;
}

export function vendorStatusOf(resolution: VendorTaxIdResolution, matched: VendorRecord | null): VendorStatus {
  if (matched) return "matched";
  return resolution.taxId ? "pending" : "taxid_unreadable";
}

/** 未登記於主檔 → 強制送入待覆核,不受信心分數影響。 */
export function requiresForcedReview(matchedVendor: VendorRecord | null): boolean {
  return matchedVendor === null;
}
