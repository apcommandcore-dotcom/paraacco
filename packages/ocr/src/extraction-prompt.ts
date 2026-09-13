// 共用的欄位擷取 prompt 與回應解析邏輯 —— PDF 文字層路徑與影像路徑共用同一份 prompt、
// 同一個解析器,確保兩種輸入來源產出同樣結構的欄位。這個檔案刻意寫成純函式(不呼叫任何
// 網路 API、不依賴 Cloudflare bindings),方便單元測試 prompt 內容與回應解析邏輯是否正確,
// 不需要真的打 Workers AI 才能測。

export interface ExtractedDocFields {
  docTypeCode?: string;
  vendorNameRaw?: string;
  vendorTaxId?: string;
  docDate?: string;
  invoiceNo?: string;
  orderNo?: string;
  serialNo?: string;
  brand?: string;
  model?: string;
  /** 金額,「元」為單位(不是分),例如 79900 或 79900.5。轉成 amountCents 由呼叫端處理。 */
  amount?: number;
  currency?: string;
  // --- 2026-09-13 財務文件自動分類新增(見 paraacco-code-handoff-package-20260913.md 第 3 節)---
  /** CORP-AP | CORP-STUDIO | PERS | PROJ-<code> | CORP-PERS | 待確認,由 @paraacco/domain 的
   * resolveScope()/classifyDocument() 進一步映射成 ownership/entity/project。 */
  scope?: string;
  /** 顯示檔名用的類型碼,見 @paraacco/domain 的 FINANCE_DOC_TYPE_CODES,跟 docTypeCode
   * (結構性,綁 CHECK 約束)是兩個獨立字典,不要混用。 */
  financeDocType?: string;
  /** 顯示用對象名稱,≤20 字(超過由 @paraacco/domain 的 truncateCounterparty() 處理),跟
   * vendorNameRaw(供應商比對用,不截斷)是兩個用途分開的欄位。 */
  counterparty?: string;
  classificationConfidence?: "high" | "medium" | "low";
  /** 一句話備註,醫療文件依命名規則 3.1 特別規則過濾,不寫入診斷/處方等細節。 */
  notes?: string;
}

/** 對應規格文件(vaultlink-v2-design-spec)2.5 節的檔名代碼表。 */
export const DOC_TYPE_CODES = ["INV", "WAR", "RET", "DEL", "ORD", "SUB", "MAN"] as const;

const CLASSIFICATION_CONFIDENCE_VALUES = ["high", "medium", "low"] as const;

/**
 * 建立擷取欄位用的 prompt。
 * @param embeddedText 若是從 PDF 抽出的內嵌文字層,傳進來一併附在 prompt 裡;影像路徑
 *   (直接讀圖辨識)不需要這個參數。
 */
export function buildExtractionPrompt(embeddedText?: string): string {
  const schema = `{
  "docTypeCode": "INV(發票) | WAR(保證書) | RET(收據) | DEL(出貨單) | ORD(訂單) | SUB(訂閱/帳單) | MAN(說明書)",
  "vendorNameRaw": "供應商/店家名稱,原文照抄,不要翻譯或簡化",
  "vendorTaxId": "統一編號,8 碼數字,查無則為 null",
  "docDate": "單據日期,格式 YYYY-MM-DD,民國年要換算成西元年。多個日期同時出現時優先取「繳費期限」,其次「開立日」,都沒有則為 null",
  "invoiceNo": "發票號碼,查無則為 null",
  "orderNo": "訂單號碼,查無則為 null",
  "serialNo": "商品序號或 IMEI,查無則為 null",
  "brand": "商品品牌,查無則為 null",
  "model": "商品型號,查無則為 null",
  "amount": "總金額數字(元,不含幣別符號、不含千分位逗號),退款/折讓用負數,查無則為 null",
  "currency": "幣別代碼,例如 TWD、USD,查無時預設 TWD",
  "scope": "CORP-AP(平行空間有限公司,含「平行空間室內裝修有限公司」字樣) | CORP-STUDIO(呂劭翊建築師事務所) | PERS(家庭/個人) | PROJ-<專案代碼>(能明確判斷出已知專案代碼時使用) | CORP-PERS(公司/個人跨界,不確定歸屬時用這個,不要用力猜) | 待確認(信心不足/手寫難辨識/無法判斷歸屬)",
  "financeDocType": "INV(發票) | RCT(收據) | INS(保費/保單) | TAX(稅務) | UTIL(水電) | TEL(電信) | BANK(銀行手續費) | CC(信用卡繳款) | REPAIR(維修) | QUOTE(估價單) | LOAN(借據) | GOV(政府公文) | DUES(公會會費) | ADMIN(行政/簽收文件) | REFUND(退款/折讓) | INCOME(收入) | TRAVEL(差旅/租賃) | MED(醫療)",
  "counterparty": "顯示用對象名稱,≤20 字,優先用比對到的既有供應商全名,查無則用擷取到的原始名稱",
  "classificationConfidence": "high | medium | low —— 對「scope 判斷本身」的信心,不是文字辨識信心,不確定歸屬時誠實填 low 或 medium,不要為了看起來篤定就填 high",
  "notes": "一句話備註(例如「手寫金額不清楚」「疑似公司代墊個人費用」),查無備註則為 null。醫療收據只能寫日期/金額/對象相關的備註,絕對不要寫入臨床診斷、處方藥名等細節"
}`;

  const instructions = [
    "你是台灣會計單據(發票/收據/保證書/出貨單/訂單/訂閱帳單/說明書/對帳單等)欄位擷取與財務",
    "分類助手。請仔細閱讀以下單據內容,擷取欄位並「只」輸出一個 JSON 物件,不要有任何額外說明",
    "文字、不要用 markdown code fence 包住。查不到的欄位一律填 null,不要憑空猜測或編造內容,",
    "尤其是 scope 判斷不確定時要誠實填 CORP-PERS 或待確認,不要為了不留空白就亂猜一個範圍。",
    "",
    `JSON 格式(欄位說明如下,實際輸出時把說明換成真正擷取到的值):\n${schema}`,
  ];

  if (embeddedText) {
    instructions.push("", "單據內容(PDF 文字層,可能包含版面雜訊,請自行判斷哪些是真正的欄位資料):", "---", embeddedText, "---");
  } else {
    instructions.push("", "單據內容是隨此訊息附上的圖片,請直接讀圖辨識。");
  }

  return instructions.join("\n");
}

/**
 * 從模型輸出文字中解析出 JSON 物件。模型常見狀況:用 ```json fenced code block 包住,
 * 或前後夾帶「好的,以下是擷取結果:」之類的說明文字 —— 這裡盡量寬容地抓出第一個看起來
 * 像 JSON 物件的片段。解析失敗回傳 null,呼叫端要能安全地當作「這次辨識失敗」處理,
 * 不能讓整條 pipeline 因為模型輸出格式跑掉而掛掉。
 */
export function parseExtractionResponse(raw: string): ExtractedDocFields | null {
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;

  const jsonSlice = candidate.slice(start, end + 1);
  try {
    const parsed = JSON.parse(jsonSlice);
    if (typeof parsed !== "object" || parsed === null) return null;
    return normalizeFields(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

function normalizeFields(obj: Record<string, unknown>): ExtractedDocFields {
  const str = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const trimmed = v.trim();
    if (!trimmed || trimmed.toLowerCase() === "null") return undefined;
    return trimmed;
  };
  const num = (v: unknown): number | undefined => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const cleaned = v.replace(/[,\s]/g, "");
      const n = Number(cleaned);
      if (!Number.isNaN(n) && cleaned !== "") return n;
    }
    return undefined;
  };

  const docTypeCode = str(obj.docTypeCode);
  const classificationConfidence = str(obj.classificationConfidence)?.toLowerCase();

  return {
    docTypeCode: docTypeCode && (DOC_TYPE_CODES as readonly string[]).includes(docTypeCode) ? docTypeCode : undefined,
    vendorNameRaw: str(obj.vendorNameRaw),
    vendorTaxId: str(obj.vendorTaxId),
    docDate: str(obj.docDate),
    invoiceNo: str(obj.invoiceNo),
    orderNo: str(obj.orderNo),
    serialNo: str(obj.serialNo),
    brand: str(obj.brand),
    model: str(obj.model),
    amount: num(obj.amount),
    currency: str(obj.currency) ?? "TWD",
    scope: str(obj.scope),
    financeDocType: str(obj.financeDocType),
    counterparty: str(obj.counterparty),
    classificationConfidence: (CLASSIFICATION_CONFIDENCE_VALUES as readonly string[]).includes(classificationConfidence ?? "")
      ? (classificationConfidence as ExtractedDocFields["classificationConfidence"])
      : undefined,
    notes: str(obj.notes),
  };
}
