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
}

/** 對應規格文件(vaultlink-v2-design-spec)2.5 節的檔名代碼表。 */
export const DOC_TYPE_CODES = ["INV", "WAR", "RET", "DEL", "ORD", "SUB", "MAN"] as const;

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
  "docDate": "單據日期,格式 YYYY-MM-DD,民國年要換算成西元年,查無則為 null",
  "invoiceNo": "發票號碼,查無則為 null",
  "orderNo": "訂單號碼,查無則為 null",
  "serialNo": "商品序號或 IMEI,查無則為 null",
  "brand": "商品品牌,查無則為 null",
  "model": "商品型號,查無則為 null",
  "amount": "總金額數字(元,不含幣別符號、不含千分位逗號),查無則為 null",
  "currency": "幣別代碼,例如 TWD、USD,查無時預設 TWD"
}`;

  const instructions = [
    "你是台灣會計單據(發票/收據/保證書/出貨單/訂單/訂閱帳單/說明書)欄位擷取助手。",
    "請仔細閱讀以下單據內容,擷取欄位並「只」輸出一個 JSON 物件,不要有任何額外說明文字、",
    "不要用 markdown code fence 包住。查不到的欄位一律填 null,不要憑空猜測或編造內容。",
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
  };
}
