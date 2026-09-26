// 統編查詢登記名稱 —— 2026-09-26 新增(管理後台「輸入統編直接新增供應商」)。
//
// 資料來源:經濟部商工行政資料開放平臺(data.gcis.nat.gov.tw,免金鑰、公開 OData API)。
// 依序查三個資料集,查到就停:
//   1. 公司登記基本資料-應用一(5F64D864…):以 Business_Accounting_NO 查公司(含有限、股份有限)
//      —— 2026-09-26 實測 83018456 可正確回傳「平行空間室內裝修有限公司」。
//   2. 分公司登記基本資料(FCB90AB1…):以 Branch_Office_Business_Accounting_NO 查分公司
//      (例如「統康生活事業股份有限公司雨聲分公司」28977199)。
//   3. 商業登記基本資料-應用三(426D5542…):以 President_No 查行號、工作室、獨資合夥商號。
//   2、3 的端點在實作當下沒有實測(平臺那天對外部抓取逾時),欄位名稱用「結尾是 _Name、排除負責人
//   /經理人」的寬鬆規則取,查不到不會報錯,只會落到下一個來源;部署後請用報告裡的 curl 各測一次。
//
// 注意:這裡查的是「登記名稱」,不是發票上的營業人名稱——兩者通常一致,但例如 83018456 登記名稱
// 是「平行空間室內裝修有限公司」、平常慣用「平行空間有限公司」。查詢結果只是帶入表單的預設值,
// 使用者可以改。財政部「營業(稅籍)登記」資料集沒有即時查詢 API(只有整包 CSV),不採用。

const GCIS_BASE = "https://data.gcis.nat.gov.tw/od/data/api";
const TIMEOUT_MS = 6000;

interface Source {
  id: string;
  label: string;
  filterField: string;
  nameKeys: string[];
}

const SOURCES: Source[] = [
  { id: "5F64D864-61CB-4D0D-8AD9-492047CC1EA6", label: "公司登記", filterField: "Business_Accounting_NO", nameKeys: ["Company_Name"] },
  {
    id: "FCB90AB1-E382-45CE-8D4F-394861851E28",
    label: "分公司登記",
    filterField: "Branch_Office_Business_Accounting_NO",
    nameKeys: ["Branch_Office_Name", "Company_Name"],
  },
  { id: "426D5542-5F05-43EB-83F9-F1300F14E1F1", label: "商業登記", filterField: "President_No", nameKeys: ["Business_Name"] },
];

export interface TaxIdLookupResult {
  taxId: string;
  name: string;
  status: string | null; // 例如「核准設立」「解散」「歇業」
  address: string | null;
  source: string; // 公司登記 / 分公司登記 / 商業登記
}

function pickName(row: Record<string, unknown>, preferred: string[]): string | null {
  for (const k of preferred) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const [k, v] of Object.entries(row)) {
    if (/_Name$/.test(k) && !/Responsible|Manager|Representative|Organization/i.test(k) && typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function pickByPattern(row: Record<string, unknown>, pattern: RegExp): string | null {
  for (const [k, v] of Object.entries(row)) {
    if (pattern.test(k) && typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

async function querySource(src: Source, taxId: string, fetcher: typeof fetch): Promise<TaxIdLookupResult | null> {
  const filter = encodeURIComponent(`${src.filterField} eq ${taxId}`);
  const url = `${GCIS_BASE}/${src.id}?$format=json&$filter=${filter}&$skip=0&$top=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetcher(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trim()) return null; // 查無資料時平臺回空字串,不是 []
    const data = JSON.parse(text) as unknown;
    const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
    if (!row) return null;
    const name = pickName(row, src.nameKeys);
    if (!name) return null;
    return {
      taxId,
      name,
      status: pickByPattern(row, /Status_Desc$/),
      address: pickByPattern(row, /Location$|Address$/),
      source: src.label,
    };
  } catch {
    return null; // 逾時/格式不符 → 換下一個來源
  } finally {
    clearTimeout(timer);
  }
}

/** 依序查公司、分公司、商號;都查不到回 null。fetcher 可注入,測試用。 */
export async function lookupTaxId(taxId: string, fetcher: typeof fetch = fetch): Promise<TaxIdLookupResult | null> {
  for (const src of SOURCES) {
    const hit = await querySource(src, taxId, fetcher);
    if (hit) return hit;
  }
  return null;
}
