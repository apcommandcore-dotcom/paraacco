// 物件(採購案)= 一筆消費 —— 2026-09-29,CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md。
// 純函式:主文件/附件角色、發票明細 → 品項、品項歸屬拆分、自動合併建議規則(第三節)、月報表(以物件為列)。
// apps/api 的 routes/purchase-objects.ts、routes/reports.ts 與回溯腳本 scripts/merge_suggestions.ts 共用。
//
// 三層結構(第五節):
//   物件(purchases)       ← 金額、對帳、月報表加總的單位 = 主文件(發票)總額
//    ├─ 文件:主文件(發票)、附件(出貨單/收據/訂單/簽單)   ← 物件層
//    └─ 品項 1..n(發票每一行)
//         └─ 文件:說明書/保固單、影片/照片、序號          ← 品項層

import { normalizeTaxId, isValidTaxId } from "./tax-id";
import { resolveVendorTaxId } from "./vendor-matching";

export const ITEM_OWNERSHIPS = ["per", "corp", "advance", "custody"] as const;

// ---------------------------------------------------------------------------
// 文件在物件中的角色
// ---------------------------------------------------------------------------

/** 附件類型。影片/照片不是 documents(存在 purchase_attachments),這裡只列單據類附件。 */
export const ATTACHMENT_ROLES = ["DEL", "RET", "ORD", "SIGN", "MAN", "WAR", "PHOTO", "OTHER"] as const;
export type AttachmentRole = (typeof ATTACHMENT_ROLES)[number];

export const ATTACHMENT_ROLE_LABELS: Record<AttachmentRole | "VIDEO", string> = {
  DEL: "出貨單",
  RET: "收據",
  ORD: "訂單",
  SIGN: "簽單",
  MAN: "說明書",
  WAR: "保固單",
  PHOTO: "照片",
  OTHER: "其他",
  VIDEO: "影片",
};

/** 品項層的附件類型(說明書、保固單、照片);其餘掛在物件層。 */
export const ITEM_LEVEL_ROLES: readonly AttachmentRole[] = ["MAN", "WAR", "PHOTO"];

/** 文件的種類(從 docTypeCode、判讀類型標籤、NAS 檔名的類型段推斷)。 */
export type DocKind = "invoice" | "receipt" | "delivery" | "order" | "manual" | "warranty" | "other";

const FILENAME_TYPE_KIND: Record<string, DocKind> = {
  發票: "invoice",
  收據: "receipt",
  出貨單: "delivery",
  訂單: "order",
  說明書: "manual",
  保固書: "warranty",
};

/** 發票號碼正規化:去掉 - 與空白、轉大寫(FK-60843564 = FK60843564)。 */
export function normalizeInvoiceNo(v: string | null | undefined): string {
  return (v ?? "").replace(/[\s-]/g, "").toUpperCase();
}

const INVOICE_NO_RE = /^[A-Z]{2}\d{8}$/;

export function docKindOf(doc: {
  docTypeCode?: string | null;
  financeDocType?: string | null;
  localPath?: string | null;
  invoiceNo?: string | null;
}): DocKind {
  const t = doc.docTypeCode ?? null;
  if (t === "INV") return "invoice";
  if (t === "RET") return "receipt";
  if (t === "DEL") return "delivery";
  if (t === "ORD") return "order";
  if (t === "MAN") return "manual";
  if (t === "WAR") return "warranty";
  const f = doc.financeDocType ?? null;
  if (f === "INV") return "invoice";
  if (f === "RCT") return "receipt";
  if (f === "DEL") return "delivery";
  if (f === "ORD") return "order";
  if (f === "MAN") return "manual";
  if (f === "WAR") return "warranty";
  // NAS 檔名 YYYYMMDD_類型_對象_…
  const typeSeg = (doc.localPath ?? "").split("/").pop()?.split("_")[1];
  if (typeSeg && FILENAME_TYPE_KIND[typeSeg]) return FILENAME_TYPE_KIND[typeSeg];
  if (INVOICE_NO_RE.test(normalizeInvoiceNo(doc.invoiceNo))) return "invoice";
  return "other";
}

/** 文件種類 → 當附件時的預設角色。 */
export function defaultAttachmentRole(kind: DocKind): AttachmentRole {
  switch (kind) {
    case "receipt":
      return "RET";
    case "delivery":
      return "DEL";
    case "order":
      return "ORD";
    case "manual":
      return "MAN";
    case "warranty":
      return "WAR";
    default:
      return "OTHER";
  }
}

/** 主文件優先順序:發票 > 收據 > 出貨單 > 訂單 > 其他。沒有發票時收據/出貨單暫代,發票進來自動接手。 */
const PRIMARY_RANK: Record<DocKind, number> = { invoice: 0, receipt: 1, delivery: 2, order: 3, other: 4, manual: 9, warranty: 9 };

export function primaryRank(kind: DocKind): number {
  return PRIMARY_RANK[kind];
}

/** 從一組文件選主文件:種類優先順序,同順序取日期早、id 小的。 */
export function pickPrimary<T extends { id: string; kind: DocKind; date?: string | null }>(docs: T[]): T | null {
  const sorted = [...docs].sort(
    (a, b) => primaryRank(a.kind) - primaryRank(b.kind) || (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.id.localeCompare(b.id),
  );
  return sorted[0] ?? null;
}

/** 新文件加入物件時:它該不該接手主文件(只有發票能從非發票手上接手;已有發票時新發票不接手)。 */
export function shouldTakeOverPrimary(newKind: DocKind, currentPrimaryKind: DocKind | null): boolean {
  if (!currentPrimaryKind) return true;
  return primaryRank(newKind) < primaryRank(currentPrimaryKind) && newKind === "invoice";
}

// ---------------------------------------------------------------------------
// 發票明細 → 品項
// ---------------------------------------------------------------------------

export interface ItemDraft {
  lineNo: number;
  name: string;
  quantity: number;
  unitPriceCents: number | null;
  amountCents: number;
  brand: string | null;
  model: string | null;
  serialNo: string | null;
}

const yuanToCents = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/** document_extracted_fields.line_items(JSON 字串,金額單位是元:[{name, code, qty, unitPrice, amount, brand?, model?, serialNo?}])
 * → 品項草稿,每一行一個,不設金額門檻;折扣行(負數)也建成品項。amount 缺漏時用 qty × unitPrice。 */
export function itemsFromLineItems(json: string | null | undefined): ItemDraft[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: ItemDraft[] = [];
  raw.forEach((r, i) => {
    if (!r || typeof r !== "object") return;
    const o = r as Record<string, unknown>;
    const qtyRaw = Number(o.qty ?? o.quantity ?? 1);
    const quantity = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
    const unit = yuanToCents(o.unitPrice ?? o.unit_price);
    const amount = yuanToCents(o.amount ?? o.subtotal) ?? (unit !== null ? Math.round(unit * quantity) : null);
    if (amount === null) return;
    const text = (k: string) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : null);
    out.push({
      lineNo: i + 1,
      name: text("name") ?? text("description") ?? `第 ${i + 1} 項`,
      quantity,
      unitPriceCents: unit,
      amountCents: amount,
      brand: text("brand"),
      model: text("model"),
      serialNo: text("serialNo") ?? text("serial_no"),
    });
  });
  return out;
}

/** 數量 n 的品項拆成多個(例:數量 2 拆成兩個品項,各掛各的序號與保固)。金額照數量比例分,尾差放第一個。 */
export function splitItem(item: { quantity: number; amountCents: number; unitPriceCents: number | null }, quantities: number[]): Array<{ quantity: number; amountCents: number }> {
  const total = quantities.reduce((a, b) => a + b, 0);
  if (!quantities.length || quantities.some((q) => !(q > 0)) || Math.abs(total - item.quantity) > 1e-9) {
    throw new Error(`拆分數量加總(${total})要等於原數量(${item.quantity})`);
  }
  const parts = quantities.map((q) => ({ quantity: q, amountCents: Math.trunc((item.amountCents * q) / item.quantity) }));
  const rest = item.amountCents - parts.reduce((a, p) => a + p.amountCents, 0);
  parts[0].amountCents += rest;
  return parts;
}

// ---------------------------------------------------------------------------
// 金額與歸屬
// ---------------------------------------------------------------------------

export interface ItemAmountLike {
  amountCents: number;
  ownership?: string | null;
}

/** 品項小計加總 ≠ 發票總額(折扣、四捨五入、辨識錯漏)→ 物件標「品項金額不符」送覆核。沒有品項不算不符。 */
export function itemAmountMismatch(invoiceCents: number | null, items: ItemAmountLike[]): boolean {
  if (!items.length || invoiceCents === null) return false;
  return items.reduce((a, i) => a + i.amountCents, 0) !== invoiceCents;
}

/** 一張發票裡有不同歸屬的品項 → 混合歸屬。 */
export function isMixedOwnership(objectOwnership: string, items: ItemAmountLike[]): boolean {
  return items.some((i) => (i.ownership ?? objectOwnership) !== objectOwnership);
}

/** 公司/個人小計依品項拆分(5.3):品項金額歸到品項歸屬(null = 跟發票),發票總額 − 品項加總的差額歸到發票歸屬。
 * 沒有混合歸屬時整筆歸發票歸屬(品項金額不符也不影響)。回傳 ownership → 分。 */
export function splitAmountByOwnership(objectOwnership: string, invoiceCents: number, items: ItemAmountLike[]): Record<string, number> {
  if (!isMixedOwnership(objectOwnership, items)) return { [objectOwnership]: invoiceCents };
  const out: Record<string, number> = {};
  let sum = 0;
  for (const i of items) {
    const own = i.ownership ?? objectOwnership;
    out[own] = (out[own] ?? 0) + i.amountCents;
    sum += i.amountCents;
  }
  out[objectOwnership] = (out[objectOwnership] ?? 0) + (invoiceCents - sum);
  return out;
}

export const DEFAULT_MIXED_OWNERSHIP_CUTOFF = "2026-10-01";
export const MIXED_OWNERSHIP_CUTOFF_KEY = "mixed_ownership_cutoff";

/** 截止日(含)之後開立的發票若是混合歸屬 → 警告「專案/公司使用應單獨開發票」,列入月報表待確認。 */
export function mixedOwnershipNeedsWarning(invoiceDate: string | null | undefined, mixed: boolean, cutoff: string = DEFAULT_MIXED_OWNERSHIP_CUTOFF): boolean {
  return mixed && !!invoiceDate && invoiceDate.slice(0, 10) >= cutoff;
}

// ---------------------------------------------------------------------------
// 自動合併建議(第三節)——只產生建議,不自動合併
// ---------------------------------------------------------------------------

export interface MergeDoc {
  id: string;
  kind: DocKind;
  status: string;
  ownership: string;
  vendorTaxId: string | null;
  vendorName: string | null;
  date: string | null; // YYYY-MM-DD(invoiceDate ?? docDate)
  amountCents: number | null;
  invoiceNo: string | null;
  orderNo: string | null;
  brand: string | null;
  model: string | null;
  serialNo: string | null;
  /** 發票品項(規則 5 比對到品項用)。 */
  items?: Array<{ lineNo: number; name: string; brand: string | null; model: string | null; serialNo: string | null }>;
  /** 已屬於的物件(API 用;回溯時都是 null)。 */
  purchaseId?: string | null;
}

/** D1 的一列文件 + 擷取欄位 → MergeDoc(API 的 loadMergeDocs 與回溯腳本共用)。 */
export function toMergeDoc(
  doc: {
    id: string;
    status: string;
    ownership: string;
    docTypeCode: string | null;
    invoiceDate: string | null;
    docDate: string | null;
    amountCents: number | null;
    invoiceNo: string | null;
    orderNo: string | null;
    brand: string | null;
    model: string | null;
    serialNo: string | null;
    vendorNameRaw: string | null;
  },
  fields: Map<string, string | null | undefined>,
  localPath: string | null,
  vendorName: string | null,
  purchaseId: string | null = null,
): MergeDoc {
  const kind = docKindOf({ docTypeCode: doc.docTypeCode, financeDocType: fields.get("finance_doc_type"), localPath, invoiceNo: doc.invoiceNo });
  return {
    id: doc.id,
    kind,
    status: doc.status,
    ownership: doc.ownership,
    vendorTaxId: resolveVendorTaxId({
      qr: fields.get("vendorTaxIdQr"),
      printed: fields.get("vendorTaxIdPrinted"),
      legacy: fields.get("vendorTaxId"),
      legacySource: fields.get("vendorTaxIdSource"),
    }).taxId,
    vendorName: vendorName ?? doc.vendorNameRaw,
    date: (doc.invoiceDate ?? doc.docDate)?.slice(0, 10) ?? null,
    amountCents: doc.amountCents,
    invoiceNo: doc.invoiceNo,
    orderNo: doc.orderNo,
    brand: doc.brand,
    model: doc.model,
    serialNo: doc.serialNo,
    items:
      kind === "invoice"
        ? itemsFromLineItems(fields.get("line_items")).map((i) => ({ lineNo: i.lineNo, name: i.name, brand: i.brand, model: i.model, serialNo: i.serialNo }))
        : [],
    purchaseId,
  };
}

export const MERGE_DOC_FIELD_KEYS = ["line_items", "finance_doc_type", "vendorTaxId", "vendorTaxIdQr", "vendorTaxIdPrinted", "vendorTaxIdSource"];

export type MergeRule = 1 | 2 | 3 | 4 | 5;

export const MERGE_RULE_LABELS: Record<MergeRule, string> = {
  1: "同一發票號碼(重複檔)",
  2: "訂單號/出貨單號相同,或出貨單印有發票號碼",
  3: "同賣方統編 + 同金額 + 日期相差 ≤ 7 天",
  4: "賣方統編缺漏,店名相近 + 同金額 + 同一天",
  5: "說明書/保固單:同品牌型號或序號,30 天內的發票",
};

export interface MergePair {
  rule: MergeRule;
  /** 主文件側(發票優先)。 */
  primaryId: string;
  otherId: string;
  note: string;
  /** 規則 4:供應商比對不確定。 */
  uncertain: boolean;
  /** 規則 5:比對到的發票品項行號。 */
  itemLineNo?: number | null;
  dayDiff: number;
  /** 店名比對:2 相近、1 缺漏、0 不相近(同規則時選主文件用)。 */
  nameMatch?: number;
}

const DAY_MS = 86400000;
function dayDiff(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const x = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const y = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(x) && Number.isFinite(y) ? Math.round(Math.abs(x - y) / DAY_MS) : null;
}

const BRAND_ALIASES: string[][] = [
  ["好市多", "COSTCO"],
  ["家樂福", "CARREFOUR", "統康"],
  ["無印良品", "MUJI"],
  ["高島屋", "TAKASHIMAYA"],
];
const NAME_NOISE = /(股份有限公司|有限公司|企業社|分公司|公司|商行|百貨|\(股\)|（股）|WHOLESALE|FOOD\s*COURT|#\d+|店)/gi;

function normName(v: string | null): string {
  return (v ?? "").replace(/髙/g, "高").replace(/臺/g, "台").toUpperCase();
}

/** 店名相近:正規化後互相包含、共用 2 字以上的中文片段/4 字以上英數字、或同一組品牌別名。 */
export function namesSimilar(a: string | null, b: string | null): boolean {
  const x = normName(a).replace(NAME_NOISE, "").replace(/[\s()（）・·.,-]/g, "");
  const y = normName(b).replace(NAME_NOISE, "").replace(/[\s()（）・·.,-]/g, "");
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  if (BRAND_ALIASES.some((g) => g.some((n) => x.includes(n)) && g.some((n) => y.includes(n)))) return true;
  const grams = (s: string) => {
    const out = new Set<string>();
    for (const m of s.match(/[一-鿿]{2,}/g) ?? []) for (let i = 0; i + 2 <= m.length; i++) out.add(m.slice(i, i + 2));
    for (const m of s.match(/[A-Z0-9]{4,}/g) ?? []) out.add(m);
    return out;
  };
  const gx = grams(x);
  for (const g of grams(y)) if (gx.has(g)) return true;
  return false;
}

const EXCLUDED = new Set(["ignored", "dup", "failed"]);
const validTax = (t: string | null) => (t && isValidTaxId(normalizeTaxId(t)) ? normalizeTaxId(t) : null);

/** 兩兩比對,回傳所有符合的配對(每一對只取最強的規則)。兩張不同號碼的發票不會被配成同一物件。 */
export function findMergePairs(docs: MergeDoc[]): MergePair[] {
  const live = docs.filter((d) => !EXCLUDED.has(d.status));
  const pairs: MergePair[] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const p = matchPair(live[i], live[j]);
      if (p) pairs.push(p);
    }
  }
  return pairs;
}

/** 只比對一份文件跟其他文件(覆核頁「合併到物件」用,O(n))。 */
export function findMergePairsFor(targetId: string, docs: MergeDoc[]): MergePair[] {
  const target = docs.find((d) => d.id === targetId);
  if (!target || EXCLUDED.has(target.status)) return [];
  const out: MergePair[] = [];
  for (const d of docs) {
    if (d.id === targetId || EXCLUDED.has(d.status)) continue;
    const p = matchPair(target, d);
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.rule - b.rule || (b.nameMatch ?? 2) - (a.nameMatch ?? 2) || a.dayDiff - b.dayDiff);
}

function orient(a: MergeDoc, b: MergeDoc): [MergeDoc, MergeDoc] {
  const ra = primaryRank(a.kind);
  const rb = primaryRank(b.kind);
  if (ra !== rb) return ra < rb ? [a, b] : [b, a];
  return (a.date ?? "") <= (b.date ?? "") ? [a, b] : [b, a];
}

function matchPair(a: MergeDoc, b: MergeDoc): MergePair | null {
  const [p, o] = orient(a, b);
  const diff = dayDiff(p.date, o.date);
  const invP = normalizeInvoiceNo(p.invoiceNo);
  const invO = normalizeInvoiceNo(o.invoiceNo);
  const bothInvoices = p.kind === "invoice" && o.kind === "invoice";

  // 規則 1:同一發票號碼 → 重複檔(兩份都是發票);只有一份是發票時是「出貨單/收據印有發票號碼」→ 規則 2。
  if (invP && invP === invO) {
    if (bothInvoices) {
      return { rule: 1, primaryId: p.id, otherId: o.id, note: `發票號碼 ${invP} 相同(${p.invoiceNo} / ${o.invoiceNo}),走重複檔流程`, uncertain: false, dayDiff: diff ?? 0 };
    }
    return { rule: 2, primaryId: p.id, otherId: o.id, note: `${o.id} 印有發票號碼 ${invP}`, uncertain: false, dayDiff: diff ?? 0 };
  }
  // 兩張不同號碼的發票是兩筆消費,不合併。
  if (bothInvoices) return null;
  // 物件裡只能有一份主文件候選以上的單據才合併;說明書/保固單走規則 5。
  const docLike = (d: MergeDoc) => d.kind !== "manual" && d.kind !== "warranty";

  // 規則 2:訂單號/出貨單號相同。
  const ordP = normalizeInvoiceNo(p.orderNo);
  if (ordP && ordP === normalizeInvoiceNo(o.orderNo) && docLike(p) && docLike(o)) {
    return { rule: 2, primaryId: p.id, otherId: o.id, note: `訂單/出貨單號 ${p.orderNo} 相同`, uncertain: false, dayDiff: diff ?? 0 };
  }

  const sameAmount = p.amountCents !== null && p.amountCents === o.amountCents;
  const taxP = validTax(p.vendorTaxId);
  const taxO = validTax(o.vendorTaxId);
  // 規則 3:同賣方統編 + 同金額 + 日期相差 ≤ 7 天。
  if (docLike(p) && docLike(o) && taxP && taxP === taxO && sameAmount && diff !== null && diff <= 7) {
    return { rule: 3, primaryId: p.id, otherId: o.id, note: `統編 ${taxP}、金額相同、相差 ${diff} 天`, uncertain: false, dayDiff: diff };
  }
  // 規則 4:統編缺漏(至少一方沒有有效統編)+ 同金額 + 同一天;店名相近才算,名稱缺漏或不相近時仍列出但標不確定。
  if (docLike(p) && docLike(o) && (!taxP || !taxO) && sameAmount && diff === 0) {
    const similar = namesSimilar(p.vendorName, o.vendorName);
    const missingName = !p.vendorName || !o.vendorName;
    const note = similar
      ? `統編缺漏,店名相近(${p.vendorName} / ${o.vendorName})、同金額、同一天`
      : missingName
        ? "統編缺漏、店名缺漏,同金額、同一天"
        : `統編缺漏,店名不相近(${p.vendorName} / ${o.vendorName}),同金額、同一天,需確認是否同一筆`;
    return { rule: 4, primaryId: p.id, otherId: o.id, note: `${note};供應商比對不確定`, uncertain: true, dayDiff: 0, nameMatch: similar ? 2 : missingName ? 1 : 0 };
  }
  // 規則 5:說明書/保固單 ↔ 發票:同品牌型號或序號,30 天內。
  const [inv, man] = p.kind === "invoice" && !docLike(o) ? [p, o] : o.kind === "invoice" && !docLike(p) ? [o, p] : [null, null];
  if (inv && man && diff !== null && diff <= 30) {
    const hit = matchItem(inv, man);
    if (hit) {
      return { rule: 5, primaryId: inv.id, otherId: man.id, note: hit.note, uncertain: false, itemLineNo: hit.lineNo, dayDiff: diff };
    }
  }
  return null;
}

function eqi(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();
}

/** 規則 5 比對到品項:序號 > 品牌+型號;只比對到發票(沒有對應品項)時 lineNo=null,掛物件層。 */
function matchItem(inv: MergeDoc, man: MergeDoc): { lineNo: number | null; note: string } | null {
  for (const it of inv.items ?? []) {
    if (eqi(it.serialNo, man.serialNo)) return { lineNo: it.lineNo, note: `序號 ${man.serialNo} 對到品項 ${it.lineNo}「${it.name}」` };
  }
  for (const it of inv.items ?? []) {
    const model = man.model?.trim();
    if (model && (eqi(it.model, model) || it.name.toUpperCase().includes(model.toUpperCase()))) {
      return { lineNo: it.lineNo, note: `型號 ${model} 對到品項 ${it.lineNo}「${it.name}」` };
    }
  }
  // 發票的 serialNo 存的是 4 碼「隨機碼」(SPEC R4),不是商品序號;太短的不拿來比,避免誤配。
  if ((man.serialNo?.trim().length ?? 0) >= 6 && eqi(inv.serialNo, man.serialNo)) {
    return { lineNo: null, note: `序號 ${man.serialNo} 對到發票(找不到對應品項,掛物件層)` };
  }
  if (man.model && eqi(inv.model, man.model) && (!man.brand || !inv.brand || eqi(inv.brand, man.brand))) {
    return { lineNo: null, note: `品牌型號 ${man.brand ?? ""} ${man.model} 對到發票(找不到對應品項,掛物件層)` };
  }
  return null;
}

export interface MergeSuggestion {
  primaryId: string;
  attachments: Array<{ documentId: string; rule: MergeRule; role: AttachmentRole; note: string; uncertain: boolean; itemLineNo: number | null }>;
  ownershipConflict: boolean;
  amountCents: number | null;
}

export interface DuplicateSuggestion {
  keepId: string;
  duplicateId: string;
  note: string;
}

/** 配對 → 物件建議:每份非主文件只掛到一個主文件(規則強的優先,同規則日期近的優先);沒有發票的群組由收據/出貨單暫代主文件。
 * 規則 1 另列成重複檔建議(較早/id 小的保留)。 */
export function buildMergeSuggestions(docs: MergeDoc[], pairs: MergePair[] = findMergePairs(docs)): {
  objects: MergeSuggestion[];
  duplicates: DuplicateSuggestion[];
} {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const duplicates: DuplicateSuggestion[] = [];
  const dupIds = new Set<string>();
  for (const p of pairs.filter((x) => x.rule === 1)) {
    const [keep, dup] = [p.primaryId, p.otherId].sort();
    if (dupIds.has(dup)) continue;
    dupIds.add(dup);
    duplicates.push({ keepId: keep, duplicateId: dup, note: p.note });
  }
  const usable = pairs.filter((p) => p.rule !== 1 && !dupIds.has(p.primaryId) && !dupIds.has(p.otherId));

  // 每份「非主文件」只選一個最好的主文件候選:規則強 > 主文件是發票 > 店名相近 > 日期近 > id 小。
  const rank = (p: MergePair) => [p.rule, primaryRank(byId.get(p.primaryId)?.kind ?? "other"), -(p.nameMatch ?? 2), p.dayDiff];
  const better = (a: MergePair, b: MergePair) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] < rb[i];
    return a.primaryId < b.primaryId;
  };
  const best = new Map<string, MergePair>();
  for (const p of usable) {
    const cur = best.get(p.otherId);
    if (!cur || better(p, cur)) best.set(p.otherId, p);
  }
  // 被選為別人主文件的文件,自己不能再當附件掛出去(避免鏈狀);主文件優先權高的留下。
  const groups = new Map<string, MergePair[]>();
  for (const p of best.values()) {
    if (best.has(p.primaryId)) {
      // 主文件本身也想掛到別人:接到那個上層主文件(只接一層)。
      const up = best.get(p.primaryId)!;
      groups.set(up.primaryId, [...(groups.get(up.primaryId) ?? []), { ...p, primaryId: up.primaryId }]);
      continue;
    }
    groups.set(p.primaryId, [...(groups.get(p.primaryId) ?? []), p]);
  }
  const objects: MergeSuggestion[] = [];
  for (const [primaryId, ps] of groups) {
    const primary = byId.get(primaryId);
    if (!primary) continue;
    const seen = new Set<string>();
    const attachments = ps
      .filter((p) => p.otherId !== primaryId && !seen.has(p.otherId) && (seen.add(p.otherId), true))
      .map((p) => {
        const other = byId.get(p.otherId)!;
        return {
          documentId: p.otherId,
          rule: p.rule,
          role: defaultAttachmentRole(other.kind),
          note: p.note,
          uncertain: p.uncertain,
          itemLineNo: p.itemLineNo ?? null,
        };
      })
      .sort((a, b) => a.documentId.localeCompare(b.documentId));
    if (!attachments.length) continue;
    objects.push({
      primaryId,
      attachments,
      ownershipConflict: attachments.some((a) => byId.get(a.documentId)!.ownership !== primary.ownership),
      amountCents: primary.amountCents,
    });
  }
  objects.sort((a, b) => a.primaryId.localeCompare(b.primaryId));
  return { objects, duplicates };
}

// ---------------------------------------------------------------------------
// 月報表(以物件為一列,依主文件是否掛定期繳費分兩段)
// ---------------------------------------------------------------------------

export interface ReportDocInput {
  id: string;
  status: string;
  ownership: string;
  invoiceDate: string | null;
  docDate: string | null;
  vendorName: string | null;
  vendorNameRaw: string | null;
  invoiceNo: string | null;
  amountCents: number | null;
  displayName: string | null;
  recurringSeriesId: string | null;
  kind: DocKind;
}

export interface ReportLinkInput {
  documentId: string;
  purchaseId: string;
  relationKind: string; // primary | supporting | duplicate_evidence
  attachmentRole: string | null;
  purchaseItemId: string | null;
}

export interface ReportItemInput {
  id: string;
  purchaseId: string;
  lineNo: number;
  name: string;
  quantity: number;
  unitPriceCents: number | null;
  amountCents: number;
  ownership: string | null;
  // 2026-10-01(V1.02 7.5)
  categoryId?: string | null;
  projectCode?: string | null;
  isAdvance?: boolean;
  advancePayee?: string | null;
  advanceSettledAt?: string | null;
  excludeFromReport?: boolean;
  excludeReason?: string | null;
}

export interface ReportAttachmentInput {
  purchaseId: string;
  purchaseItemId: string | null;
  kind: string; // video | photo | other
}

export interface ReportRowItem extends ReportItemInput {
  effectiveOwnership: string;
  attachmentCount: number;
}

export interface ReportRow {
  key: string;
  purchaseId: string | null;
  primaryDocumentId: string;
  date: string | null;
  vendor: string;
  vendorRegistered: boolean;
  invoiceNo: string | null;
  ownership: string;
  status: string;
  amountCents: number | null;
  /** 發票總額(amountCents 已扣掉不列帳品項)。 */
  invoiceAmountCents?: number | null;
  segment: "recurring" | "general";
  recurringSeriesId: string | null;
  attachmentSummary: string;
  attachmentDocumentIds: string[];
  items: ReportRowItem[];
  mixedOwnership: boolean;
  itemAmountMismatch: boolean;
  needsConfirm: boolean;
  ownershipSplit: Record<string, number>;
}

export interface ReportSubtotals {
  byOwnership: Record<string, { count: number; cents: number }>;
  count: number;
  cents: number;
}

/** 依費用類別/專案的小計(V1.02 7.5):未分類 = 沒設類別的品項 + 發票總額與品項加總的差額 + 沒有品項的物件。加總 = 報表總計。 */
export const UNCATEGORIZED = "__none__";

export interface ReportItemListEntry {
  itemId: string;
  purchaseId: string;
  primaryDocumentId: string;
  date: string | null;
  vendor: string;
  name: string;
  amountCents: number;
  advancePayee?: string | null;
  reason?: string | null;
}

export interface MonthlyReport {
  month: string;
  byCategory: Record<string, number>;
  byProject: Record<string, number>;
  /** 代墊(仍計入金額,另列方便請款)。 */
  advanceItems: ReportItemListEntry[];
  /** 不列帳(不計入金額)。 */
  excludedItems: ReportItemListEntry[];
  recurring: { rows: ReportRow[]; subtotals: ReportSubtotals };
  general: { rows: ReportRow[]; subtotals: ReportSubtotals };
  total: ReportSubtotals;
  pendingConfirm: string[];
  missingAmount: number;
  noDate: number;
}

function emptySubtotals(): ReportSubtotals {
  return { byOwnership: {}, count: 0, cents: 0 };
}

function addToSubtotals(s: ReportSubtotals, row: ReportRow): void {
  s.count += 1;
  s.cents += row.amountCents ?? 0;
  const split = row.amountCents === null ? { [row.ownership]: 0 } : row.ownershipSplit;
  const owners = Object.keys(split);
  for (const own of owners) {
    const cur = s.byOwnership[own] ?? { count: 0, cents: 0 };
    cur.cents += split[own];
    // 筆數算在物件歸屬;混合歸屬的其他歸屬只加金額。
    if (own === row.ownership) cur.count += 1;
    s.byOwnership[own] = cur;
  }
  if (!owners.includes(row.ownership)) {
    const cur = s.byOwnership[row.ownership] ?? { count: 0, cents: 0 };
    cur.count += 1;
    s.byOwnership[row.ownership] = cur;
  }
}

/** 月報表:所有金額以物件為單位——每個物件一列(主文件的日期/供應商/金額/歸屬),附件不計金額;還沒合併的單獨文件
 * 視為只有一份文件的物件。依主文件有沒有 recurring_series_id 分「定期繳費/一般消費」兩段;混合歸屬依品項拆分小計。 */
export function buildMonthlyReport(input: {
  month: string;
  docs: ReportDocInput[];
  links: ReportLinkInput[];
  items: ReportItemInput[];
  attachments: ReportAttachmentInput[];
  statusFilter: (status: string) => boolean;
  ownershipFilter?: string | null;
  cutoff?: string;
}): MonthlyReport {
  const docsById = new Map(input.docs.map((d) => [d.id, d]));
  const linksByPurchase = new Map<string, ReportLinkInput[]>();
  const linkByDoc = new Map<string, ReportLinkInput>();
  for (const l of input.links) {
    if (l.relationKind === "duplicate_evidence") continue;
    linksByPurchase.set(l.purchaseId, [...(linksByPurchase.get(l.purchaseId) ?? []), l]);
    linkByDoc.set(l.documentId, l);
  }
  const itemsByPurchase = new Map<string, ReportItemInput[]>();
  for (const it of input.items) itemsByPurchase.set(it.purchaseId, [...(itemsByPurchase.get(it.purchaseId) ?? []), it]);

  const rows: ReportRow[] = [];
  let noDate = 0;
  const handledPurchases = new Set<string>();
  for (const d of input.docs) {
    const link = linkByDoc.get(d.id);
    // 附件不自成一列。
    if (link && link.relationKind !== "primary") continue;
    if (!input.statusFilter(d.status)) continue;
    const date = d.invoiceDate ?? d.docDate;
    if (!date) {
      noDate++;
      continue;
    }
    if (!date.startsWith(input.month)) continue;
    const purchaseId = link?.purchaseId ?? null;
    if (purchaseId) {
      if (handledPurchases.has(purchaseId)) continue;
      handledPurchases.add(purchaseId);
    }
    if (input.ownershipFilter && d.ownership !== input.ownershipFilter) continue;

    const plinks = purchaseId ? (linksByPurchase.get(purchaseId) ?? []) : [];
    const attachmentLinks = plinks.filter((l) => l.relationKind !== "primary");
    const extra = purchaseId ? input.attachments.filter((a) => a.purchaseId === purchaseId) : [];
    const counts = new Map<string, number>();
    for (const l of attachmentLinks) {
      const label = ATTACHMENT_ROLE_LABELS[(l.attachmentRole ?? "OTHER") as AttachmentRole] ?? l.attachmentRole ?? "其他";
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    for (const a of extra) {
      const label = a.kind === "video" ? "影片" : a.kind === "photo" ? "照片" : "其他";
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const rawItems = purchaseId ? [...(itemsByPurchase.get(purchaseId) ?? [])].sort((a, b) => a.lineNo - b.lineNo) : [];
    const items: ReportRowItem[] = rawItems.map((it) => ({
      ...it,
      effectiveOwnership: it.ownership ?? d.ownership,
      attachmentCount:
        attachmentLinks.filter((l) => l.purchaseItemId === it.id).length + extra.filter((a) => a.purchaseItemId === it.id).length,
    }));
    // 不列帳的品項(V1.02 7.2 第 7 項)不計入金額:物件金額 = 發票總額 − 不列帳品項。
    const includedItems = rawItems.filter((it) => !it.excludeFromReport);
    const excludedCents = rawItems.filter((it) => it.excludeFromReport).reduce((a, it) => a + it.amountCents, 0);
    const effectiveAmount = d.amountCents === null ? null : d.amountCents - excludedCents;
    const mixed = isMixedOwnership(d.ownership, includedItems);
    const vendor = d.vendorName ?? d.vendorNameRaw ?? d.displayName ?? "—";
    rows.push({
      key: purchaseId ?? d.id,
      purchaseId,
      primaryDocumentId: d.id,
      date,
      vendor,
      vendorRegistered: !!d.vendorName,
      invoiceNo: d.invoiceNo,
      ownership: d.ownership,
      status: d.status,
      amountCents: effectiveAmount,
      invoiceAmountCents: d.amountCents,
      segment: d.recurringSeriesId ? "recurring" : "general",
      recurringSeriesId: d.recurringSeriesId,
      attachmentSummary: [...counts.entries()].map(([k, v]) => `${k} ${v}`).join("・"),
      attachmentDocumentIds: attachmentLinks.map((l) => l.documentId).filter((id) => docsById.has(id)),
      items,
      mixedOwnership: mixed,
      itemAmountMismatch: itemAmountMismatch(d.amountCents, rawItems),
      needsConfirm: mixedOwnershipNeedsWarning(d.invoiceDate, mixed, input.cutoff),
      ownershipSplit: effectiveAmount === null ? {} : splitAmountByOwnership(d.ownership, effectiveAmount, includedItems),
    });
  }
  rows.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.primaryDocumentId.localeCompare(b.primaryDocumentId));

  const out: MonthlyReport = {
    month: input.month,
    recurring: { rows: [], subtotals: emptySubtotals() },
    general: { rows: [], subtotals: emptySubtotals() },
    total: emptySubtotals(),
    pendingConfirm: [],
    missingAmount: 0,
    noDate,
    byCategory: {},
    byProject: {},
    advanceItems: [],
    excludedItems: [],
  };
  const add = (m: Record<string, number>, k: string, v: number) => (m[k] = (m[k] ?? 0) + v);
  for (const r of rows) {
    const seg = out[r.segment];
    seg.rows.push(r);
    addToSubtotals(seg.subtotals, r);
    addToSubtotals(out.total, r);
    if (r.needsConfirm) out.pendingConfirm.push(r.key);
    if (r.amountCents === null) out.missingAmount++;
    const items = r.purchaseId ? (itemsByPurchase.get(r.purchaseId) ?? []) : [];
    const included = items.filter((it) => !it.excludeFromReport);
    const total = r.amountCents ?? 0;
    const itemsSum = included.reduce((a, it) => a + it.amountCents, 0);
    for (const it of included) {
      add(out.byCategory, it.categoryId ?? UNCATEGORIZED, it.amountCents);
      add(out.byProject, it.projectCode ?? UNCATEGORIZED, it.amountCents);
    }
    add(out.byCategory, UNCATEGORIZED, total - itemsSum);
    add(out.byProject, UNCATEGORIZED, total - itemsSum);
    for (const it of items) {
      const entry = { itemId: it.id, purchaseId: it.purchaseId, primaryDocumentId: r.primaryDocumentId, date: r.date, vendor: r.vendor, name: it.name, amountCents: it.amountCents };
      if (it.excludeFromReport) out.excludedItems.push({ ...entry, reason: it.excludeReason ?? null });
      else if (it.isAdvance) out.advanceItems.push({ ...entry, advancePayee: it.advancePayee ?? null });
    }
  }
  for (const m of [out.byCategory, out.byProject]) if (m[UNCATEGORIZED] === 0) delete m[UNCATEGORIZED];
  return out;
}

// ---------------------------------------------------------------------------
// 品項自動套用規則(V1.02 7.4):條件 = 賣方統編(必填)+ 品名關鍵字(可空)→ 類別/歸屬/專案。
// 衝突時:有品名關鍵字的較具體者優先,再以最新建立者(id 大)優先。停用的規則不套用。
// ---------------------------------------------------------------------------
export interface ItemRuleLike {
  id: number;
  vendorTaxId: string;
  nameKeyword: string | null;
  categoryId: string | null;
  ownership: string | null;
  projectCode: string | null;
  isActive: boolean;
}

export function pickItemRule<T extends ItemRuleLike>(rules: T[], vendorTaxId: string | null | undefined, itemName: string): T | null {
  if (!vendorTaxId) return null;
  const tax = normalizeTaxId(vendorTaxId);
  const hits = rules.filter((r) => r.isActive && normalizeTaxId(r.vendorTaxId) === tax && (!r.nameKeyword || itemName.includes(r.nameKeyword)));
  hits.sort((a, b) => Number(!!b.nameKeyword) - Number(!!a.nameKeyword) || (b.nameKeyword?.length ?? 0) - (a.nameKeyword?.length ?? 0) || b.id - a.id);
  return hits[0] ?? null;
}
