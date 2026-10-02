// 擷取結果寫回(pipeline 之外完成的判讀,見 CODE_TASK_extraction-writeback-api_20260923.md、
// SPEC-extraction-prompt-rules_20260923_V1.02.md 第三節欄位對應——V1.02 修正了 V1.01 跟內部
// pipeline 既有欄位鍵(vendorTaxId/buyerTaxId/invoicePeriod)命名不一致的三個地方,V1.01
// 唯讀保留、不覆蓋)——目前判讀者是 Theo 在 Claude 對話中人工判讀,未來可能換成 Gemini
// 付費 API 的 server-side 呼叫。走 middleware/extraction-writeback-auth.ts 的共用密鑰驗證
// (見該檔案開頭說明,不是 Access、不是 internal-auth、不是 batch-auth)。
//
// 兩支端點:
//   GET  /api/extraction-writeback/documents      列出待擷取文件(見階段一 Q3 決議:用
//        「資料庫實際狀態」——有 R2 原檔、但沒有任何 REAL_EXTRACTION_FIELD_KEYS 白名單內的
//        擷取欄位——不是 pipeline 進度,因為 job 狀態全部 completed 但欄位是空的那個 bug
//        (CODE_REPORT_batch-ingest-no-ocr-207docs-root-cause_20260922.md)已經證明 pipeline
//        進度會騙人)。
//   POST /api/extraction-writeback/documents/:id  寫回單一文件的擷取結果。
//   POST /api/extraction-writeback/documents/:id/normalized-file  上傳裁切空白+轉正後的顯示用
//        PDF(2026-09-26 新增),存成 document_files kind='normalized_pdf',原檔 original 不動。
//        2026-09-28 起 storage='local' 的文件回 409(顯示檔不再上傳)。

import { Hono } from "hono";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { activityLog, createDb, documentExtractedFields, documentFiles, documents, syncDocumentFts } from "@paraacco/db";
import { EXTERNAL_EXTRACTION_SOURCE_NOTE_PREFIX, REAL_EXTRACTION_FIELD_KEYS } from "@paraacco/domain";
import type { Bindings } from "../bindings";

export const extractionWritebackRoute = new Hono<{ Bindings: Bindings }>();

const CONFIDENCE_VALUES = ["high", "medium", "low"] as const;
type ConfidenceLevel = (typeof CONFIDENCE_VALUES)[number];
// 信心度(high/medium/low)→ documents.ocrConfidence(0–100)的對應分數——沿用既有
// calculateOverallConfidence() 0–100 的量尺,但這裡不是加權平均,是直接映射一個固定基準值
// (跟 GeminiOcrProvider 用固定基準值當單一欄位信心分數是同一個精神,見該檔案開頭註解)。
// 這是這次實作新訂的映射值,不是既有慣例照搬,若你覺得三個級距不合適,請先告知。
const CONFIDENCE_SCORE: Record<ConfidenceLevel, number> = { high: 90, medium: 60, low: 20 };

const OWNERSHIP_VALUES = ["per", "corp", "advance", "custody"] as const;

interface ExtractionWritebackBody {
  /** 發票號碼 → documents.invoiceNo */
  invoiceNo?: string | null;
  /** 交易日期時間(SPEC R2:跟發票期別是兩個欄位)→ documents.invoiceDate */
  invoiceDate?: string | null;
  /** 發票期別 → document_extracted_fields:invoicePeriod(2026-09-24 修正:原本照 SPEC V1.01
   * 原文用 snake_case invoice_period,跟內部 pipeline 既有的 camelCase invoicePeriod 是兩把
   * 不同的鍵,已改成統一用 invoicePeriod,見 SPEC V1.02 的修正說明) */
  invoicePeriod?: string | null;
  /** 賣方統編 → document_extracted_fields:vendorTaxId(2026-09-24 修正:原本照 SPEC V1.01
   * 原文用 seller_tax_id,但這個概念在內部 pipeline 裡就是 vendorTaxId——不只是命名不一致,
   * stage-7-vendor-check 實際會讀 ocrResult.vendorTaxId 做供應商比對,用不同的鍵寫入會讓
   * 寫回後 retry 時比對不到供應商統編,不是單純命名問題) */
  vendorTaxId?: string | null;
  /** 賣方名稱(發票所載營業人全名,SPEC R3)→ documents.vendorNameRaw */
  vendorNameRaw?: string | null;
  /** 品牌(SPEC R3:招牌品牌另存,跟賣方名稱不同)→ documents.brand */
  brand?: string | null;
  /** 買方統編 → document_extracted_fields:buyerTaxId(2026-09-24 修正:統一成內部既有的
   * camelCase 鍵,理由同 invoicePeriod/vendorTaxId)。SPEC R7 的「買方統編決定 ownership」
   * 規則刻意不在伺服器端實作——2026-09-24 你的決議:規則留在擷取規格裡,由外部判讀時直接
   * 決定 ownership、透過下面的 ownership 欄位傳進來,伺服器不自己猜,規則要改只改一處
   * (擷取規格),不用同時改伺服器程式碼。 */
  buyerTaxId?: string | null;
  /** 歸屬(per/corp/advance/custody)—— 由外部判讀依 SPEC R7(買方統編)決定後直接傳入,
   * 伺服器只驗證合法值、不自己判斷。提供時視為「呼叫端已確認」,一併把
   * documents.ownershipConfirmed 設成 true(跟 routes/batch-import.ts 的 ownershipHint
   * 同一個機制),否則寫回後 retry 觸發的 /classify 會用 classifyDocument() 的預設判斷結果
   * 蓋掉這裡傳入的值。 */
  ownership?: string | null;
  /** 含稅總計(分,整數,2026-09-24 你的決議:金額一律整數分,不接受小數,不做單位轉換)
   * → documents.amountCents */
  amountCents?: number | null;
  /** 應稅(分,整數)→ document_extracted_fields:taxable_amount */
  taxableAmountCents?: number | null;
  /** 未稅(分,整數)→ document_extracted_fields:net_amount */
  netAmountCents?: number | null;
  /** 稅額(分,整數)→ document_extracted_fields:tax_amount */
  taxAmountCents?: number | null;
  /** 免稅(分,整數)→ document_extracted_fields:tax_free_amount */
  taxFreeAmountCents?: number | null;
  /** 機台號 → document_extracted_fields:machine_no(SPEC 全新概念,內部 pipeline 沒有同義
   * 既有欄位,沿用 SPEC 原文 snake_case——document_extracted_fields.fieldKey 在這個
   * codebase 本來就不是純 camelCase 慣例,/classify 端點自己寫的 entity_id/project_id
   * 建議欄位也是 snake_case,見該端點) */
  machineNo?: string | null;
  /** 序號/隨機碼 → documents.serialNo */
  serialNo?: string | null;
  /** 付款方式 → document_extracted_fields:payment_method */
  paymentMethod?: string | null;
  /** 品項明細 → document_extracted_fields:line_items(伺服器端 JSON.stringify) */
  lineItems?: unknown[] | null;
  /** 信心度(SPEC 二、6,每份文件必填)→ documents.ocrConfidence,見 CONFIDENCE_SCORE */
  confidence: ConfidenceLevel;
  /** 備註(SPEC 二、6,每份文件必填,例如讀不到的原因)→ 併入 activity_log 稽核文字 */
  notes?: string | null;
  /** 判讀來源標籤(必填,例如 "Claude 對話判讀"、"Gemini 付費 API")→ 併入 sourceNote 與
   * activity_log,供之後區分是誰/什麼判讀的。 */
  source: string;
}

// 直接促升到 documents 直欄的欄位(同時也用同一個 fieldKey 寫一列 document_extracted_fields,
// 見 apps/document-worker/src/workflow.ts stage-4-extract 的註解:跳過檢查讀的是
// document_extracted_fields 的列,不是 documents 欄位,這幾項不雙寫的話,寫回後 pipeline
// retry 永遠偵測不到已經有真實資料,Gemini 還是會被叫用/覆蓋)。fieldKey 都落在
// REAL_EXTRACTION_FIELD_KEYS 白名單內。
interface FieldDef {
  bodyKey: keyof ExtractionWritebackBody;
  fieldKey: string;
  label: string;
  /** documents 表對應的直欄名(camelCase,drizzle 欄位名)。null = 只寫 document_extracted_fields,
   * 不促升。 */
  docColumn: keyof typeof documents.$inferInsert | null;
}

const TEXT_FIELD_DEFS: FieldDef[] = [
  { bodyKey: "invoiceNo", fieldKey: "invoiceNo", label: "發票號碼", docColumn: "invoiceNo" },
  { bodyKey: "invoiceDate", fieldKey: "invoiceDate", label: "交易日期時間", docColumn: "invoiceDate" },
  { bodyKey: "vendorNameRaw", fieldKey: "vendorNameRaw", label: "賣方名稱", docColumn: "vendorNameRaw" },
  { bodyKey: "brand", fieldKey: "brand", label: "品牌", docColumn: "brand" },
  { bodyKey: "serialNo", fieldKey: "serialNo", label: "序號/隨機碼", docColumn: "serialNo" },
  // 這三項統一改成內部 pipeline 既有的 camelCase 鍵(2026-09-24 修正,見上方
  // ExtractionWritebackBody 各欄位的註解)——vendorTaxId、buyerTaxId、invoicePeriod
  // 都已經在 REAL_EXTRACTION_FIELD_KEYS 白名單內,不需要另外加。
  { bodyKey: "invoicePeriod", fieldKey: "invoicePeriod", label: "發票期別", docColumn: null },
  { bodyKey: "vendorTaxId", fieldKey: "vendorTaxId", label: "賣方統編", docColumn: null },
  { bodyKey: "buyerTaxId", fieldKey: "buyerTaxId", label: "買方統編", docColumn: null },
  // 這兩項是 SPEC 全新概念,內部 pipeline 沒有同義既有欄位,沿用 SPEC 原文 snake_case
  // (見上方註解:document_extracted_fields.fieldKey 本來就不是純 camelCase 慣例)。
  { bodyKey: "machineNo", fieldKey: "machine_no", label: "機台號", docColumn: null },
  { bodyKey: "paymentMethod", fieldKey: "payment_method", label: "付款方式", docColumn: null },
];

const AMOUNT_FIELD_DEFS: FieldDef[] = [
  { bodyKey: "amountCents", fieldKey: "amountCents", label: "含稅總計", docColumn: "amountCents" },
  { bodyKey: "taxableAmountCents", fieldKey: "taxable_amount", label: "應稅", docColumn: null },
  { bodyKey: "netAmountCents", fieldKey: "net_amount", label: "未稅", docColumn: null },
  { bodyKey: "taxAmountCents", fieldKey: "tax_amount", label: "稅額", docColumn: null },
  { bodyKey: "taxFreeAmountCents", fieldKey: "tax_free_amount", label: "免稅", docColumn: null },
];

interface FieldWrite {
  fieldKey: string;
  label: string;
  value: string;
  normalizedValue?: string;
  docColumn: keyof typeof documents.$inferInsert | null;
  docValue?: unknown;
}

// 待擷取文件(見階段一 Q3 決議)—— 有目前生效的 original 檔案,但 document_extracted_fields
// 完全沒有任何 REAL_EXTRACTION_FIELD_KEYS 白名單內的欄位。用子查詢(不是先抓全部
// documentId 再 inArray),避免重演 routes/documents.ts 2026-09-22 修正過的「D1 單查詢 100
// bound params 上限」問題(見該檔案該處註解)。
extractionWritebackRoute.get("/documents", async (c) => {
  const db = createDb(c.env.DB);
  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 50;

  const extractedDocIds = db
    .selectDistinct({ documentId: documentExtractedFields.documentId })
    .from(documentExtractedFields)
    .where(inArray(documentExtractedFields.fieldKey, [...REAL_EXTRACTION_FIELD_KEYS]));

  const rows = await db
    .select({
      id: documents.id,
      r2Key: documentFiles.r2Key,
      // 2026-09-28:storage='local' 的文件原檔在 NAS(r2Key 只是佔位值),判讀端照 localPath 讀檔。
      storage: documentFiles.storage,
      localPath: documentFiles.localPath,
      sha256: documentFiles.sha256,
      originalFileName: documentFiles.originalFileName,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .innerJoin(
      documentFiles,
      and(eq(documentFiles.documentId, documents.id), eq(documentFiles.kind, "original"), eq(documentFiles.isCurrent, true)),
    )
    .where(notInArray(documents.id, extractedDocIds))
    .orderBy(documents.createdAt)
    .limit(limit);

  return c.json({ documents: rows });
});

extractionWritebackRoute.post("/documents/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<ExtractionWritebackBody>().catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);

  if (!body.source || typeof body.source !== "string") {
    return c.json({ error: "missing_source" }, 400);
  }
  if (!CONFIDENCE_VALUES.includes(body.confidence)) {
    return c.json({ error: "invalid_confidence", allowed: CONFIDENCE_VALUES }, 400);
  }
  if (body.ownership != null && !(OWNERSHIP_VALUES as readonly string[]).includes(body.ownership)) {
    return c.json({ error: "invalid_ownership", allowed: OWNERSHIP_VALUES }, 400);
  }

  // 金額一律整數分:收到浮點數一律拒絕,回 400,不自行四捨五入(2026-09-24 你的決議,取代
  // 這次實作最初版本的「收元、伺服器端 ×100」設計)。
  const invalidAmountFields: string[] = [];
  for (const def of AMOUNT_FIELD_DEFS) {
    const v = body[def.bodyKey];
    if (v === null || v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v)) invalidAmountFields.push(def.bodyKey);
  }
  if (invalidAmountFields.length) {
    return c.json({ error: "invalid_amount", fields: invalidAmountFields, message: "金額必須是整數分,不接受小數" }, 400);
  }
  if (body.lineItems !== undefined && body.lineItems !== null && !Array.isArray(body.lineItems)) {
    return c.json({ error: "invalid_line_items", message: "lineItems 必須是陣列" }, 400);
  }

  const db = createDb(c.env.DB);
  const [doc] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  if (!doc) return c.json({ error: "not_found" }, 404);

  const existingFields = await db.select().from(documentExtractedFields).where(eq(documentExtractedFields.documentId, id));
  const existingByKey = new Map(existingFields.map((f) => [f.fieldKey, f]));

  const sourceNote = `${EXTERNAL_EXTRACTION_SOURCE_NOTE_PREFIX}${body.source}`;
  const confidenceScore = CONFIDENCE_SCORE[body.confidence];

  const candidates: FieldWrite[] = [];
  for (const def of TEXT_FIELD_DEFS) {
    const v = body[def.bodyKey];
    if (v === null || v === undefined) continue;
    candidates.push({ fieldKey: def.fieldKey, label: def.label, value: String(v), docColumn: def.docColumn, docValue: v });
  }
  for (const def of AMOUNT_FIELD_DEFS) {
    const v = body[def.bodyKey];
    if (v === null || v === undefined) continue;
    // 輸入本身就是整數分,value/normalizedValue 是同一個數字——不像「收元轉分」時兩者代表
    // 不同單位,這裡沒有單位轉換,存兩份只是延續 SPEC「value 原樣字串、normalizedValue
    // 整數分」的欄位形狀。
    candidates.push({
      fieldKey: def.fieldKey,
      label: def.label,
      value: String(v),
      normalizedValue: String(v),
      docColumn: def.docColumn,
      docValue: v,
    });
  }
  if (body.lineItems != null) {
    candidates.push({ fieldKey: "line_items", label: "品項明細", value: JSON.stringify(body.lineItems), docColumn: null });
  }
  // 2026-09-28:判讀備註開頭的類型標籤([INV]、[CCS]、[UTIL]…,SPEC-extraction-prompt-rules)另存成
  // finance_doc_type——scripts/archive.py 依它決定 NAS 歸檔類別資料夾(01_發票收據、04_對帳單…)。
  const financeDocType = /^\s*\[([A-Z_]{2,12})\]/.exec(body.notes ?? "")?.[1];
  if (financeDocType) {
    candidates.push({ fieldKey: "finance_doc_type", label: "單據類型", value: financeDocType, docColumn: null });
  }
  // CODE_TASK V1.04:信用卡帳單、銀行對帳單一律「共用」(不分主體,作各帳單的對帳依據)。documents.ownership 的
  // CHECK 沒有 shared,改寫 ownership_scope 欄位;ownershipConfirmed 不動。
  if (financeDocType === "CCS" || financeDocType === "BNK") {
    candidates.push({ fieldKey: "ownership_scope", label: "歸屬範圍", value: "shared", docColumn: null });
  }

  // 不覆蓋人工確認值(CODE_TASK 階段二 B 項需求 6):該欄位既有列若 isUserConfirmed = true,
  // 這欄(包含對應的 documents 直欄,視為同一個邏輯欄位)整個跳過,在回應中列出。
  const toWrite: FieldWrite[] = [];
  const skippedUserConfirmed: string[] = [];
  for (const cand of candidates) {
    if (existingByKey.get(cand.fieldKey)?.isUserConfirmed) {
      skippedUserConfirmed.push(cand.fieldKey);
    } else {
      toWrite.push(cand);
    }
  }

  const now = new Date().toISOString();
  const documentsPatch: Record<string, unknown> = {
    ocrConfidence: confidenceScore,
    status: "review", // CODE_TASK 階段二 B 項需求 3:寫入後一律 review,不得自動 archived。
    updatedAt: now,
  };
  for (const w of toWrite) {
    if (w.docColumn) documentsPatch[w.docColumn] = w.docValue;
  }
  // ownership 由外部判讀直接決定、傳進來(2026-09-24 你的決議:R7 規則不在伺服器端實作,
  // 規則留在擷取規格裡,改規則只改一處)。跟 ownershipConfirmed 一起設,理由見上方
  // ExtractionWritebackBody.ownership 的註解——不設的話,retry 觸發的 /classify 會用
  // classifyDocument() 的預設判斷結果蓋掉這裡傳入的值。
  if (body.ownership != null) {
    documentsPatch.ownership = body.ownership;
    documentsPatch.ownershipConfirmed = true;
  }

  const statements = [
    db.update(documents).set(documentsPatch).where(eq(documents.id, id)),
    ...toWrite.map((w) =>
      db
        .insert(documentExtractedFields)
        .values({
          documentId: id,
          fieldKey: w.fieldKey,
          label: w.label,
          value: w.value,
          normalizedValue: w.normalizedValue ?? null,
          confidence: confidenceScore,
          extractionSource: "ai_inference" as const,
          sourceNote,
        })
        .onConflictDoUpdate({
          target: [documentExtractedFields.documentId, documentExtractedFields.fieldKey],
          set: { value: w.value, normalizedValue: w.normalizedValue ?? null, confidence: confidenceScore, extractionSource: "ai_inference", sourceNote },
        }),
    ),
  ] as const;

  try {
    // 用 upsert(onConflictDoUpdate,靠 document_extracted_fields_doc_field_idx 這個既有的
    // (documentId, fieldKey) unique index)不是 delete + insert——CODE_TASK 階段二 B 項需求 1
    // 要求冪等:同一份文件重複寫入同樣內容不能長出重複列。/internal/documents/:id/fields 的
    // 「先刪全部再插入」做法對這裡不適用,會把 isUserConfirmed 標記、以及這次跳過的欄位一起
    // 清掉。整批包成一次 db.batch()(D1 batch 保證原子性,同一份精神見
    // routes/internal/documents.ts 的 :id/fields 端點註解),不做逐欄位的部分寫入——
    // 上面已經先做過型別/整數驗證,實務上不會有「部分欄位失敗、部分成功」的情況,失敗一律
    // 整批不生效,回應會列出這次嘗試寫入的完整欄位清單方便重試判斷。
    await db.batch(statements);
  } catch (err) {
    return c.json(
      {
        error: "write_failed",
        message: err instanceof Error ? err.message : String(err),
        attemptedFields: toWrite.map((w) => w.fieldKey),
      },
      500,
    );
  }

  await syncDocumentFts(db, id);

  const writtenLabel = toWrite.length ? toWrite.map((w) => w.fieldKey).join(", ") : "(無新欄位)";
  const skippedLabel = skippedUserConfirmed.length ? `;略過已人工確認欄位:${skippedUserConfirmed.join(", ")}` : "";
  await db.insert(activityLog).values({
    entityType: "document",
    entityId: id,
    kind: "ocr",
    text: `外部擷取寫回(來源:${body.source},信心度:${body.confidence}):寫入 ${writtenLabel}${skippedLabel}${body.notes ? `;備註:${body.notes}` : ""}`,
    actorMemberId: null,
  });

  // 重新排進 pipeline(reason: 'retry',跟 routes/documents.ts 的 /:id/retry 端點同一個機制)
  // ——寫回的欄位要靠 apps/document-worker 的 stage-3-ocr 重新判斷才會正確跳過 Gemini、
  // 靠 stage-5 重新計算加權信心分數、靠 stage-6/7 補上關聯候選跟供應商比對,見
  // CODE_REPORT_extraction-writeback-api-phase2-proposals_20260923.md 提案 1 的連帶影響
  // 說明。stage-8-decision 已經改成:只要這次判斷是「有外部欄位」就強制 review,不會因為
  // retry 跑出高分候選就被自動關聯/歸檔掉(見 workflow.ts 該處註解)。
  await c.env.DOCUMENT_QUEUE.send({ documentId: id, reason: "retry" });

  return c.json({
    ok: true,
    written: toWrite.map((w) => w.fieldKey),
    skippedUserConfirmed,
    requeued: true,
  });
});


// ---------------------------------------------------------------------------
// 顯示用正規化檔案(2026-09-26 新增)—— 外部判讀時順便把掃描檔裁掉空白、轉正、重新壓縮
// (見 ~/dev/_reports/paraacco/extraction-*/normalize 腳本),上傳到這裡存成
// document_files kind='normalized_pdf'(schema 本來就預留這個 kind)。
//
// 設計重點:
//   - original 完全不動:sha256 重複偵測(internal/documents.ts duplicate-check)、pipeline
//     stage-2/3 都只看 kind='original',正規化檔不會影響去重與擷取。
//   - 冪等:同一份文件上傳 sha256 相同的正規化檔,直接回 ok、不重複寫 R2/D1。內容不同時,舊的
//     normalized_pdf 標 isCurrent=false(R2 物件保留,不刪),新的設為 current。
//   - 只收 application/pdf,上限跟 batch-import 一樣 25MB,開頭必須是 %PDF-。
//   - GET /api/documents/:id/file 預設優先回傳 current normalized_pdf(沒有才回 original),
//     ?kind=original 仍可取原檔。
// ---------------------------------------------------------------------------
const NORMALIZED_MAX_BYTES = 25 * 1024 * 1024;

extractionWritebackRoute.post("/documents/:id/normalized-file", async (c) => {
  const id = c.req.param("id");
  const contentType = (c.req.header("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/pdf") return c.json({ error: "invalid_content_type", expected: "application/pdf" }, 415);

  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) return c.json({ error: "empty_body" }, 400);
  if (bytes.byteLength > NORMALIZED_MAX_BYTES) return c.json({ error: "too_large", maxBytes: NORMALIZED_MAX_BYTES }, 413);
  const head = new TextDecoder().decode(new Uint8Array(bytes, 0, Math.min(5, bytes.byteLength)));
  if (head !== "%PDF-") return c.json({ error: "not_a_pdf" }, 400);

  const db = createDb(c.env.DB);
  const [doc] = await db.select({ id: documents.id }).from(documents).where(eq(documents.id, id)).limit(1);
  if (!doc) return c.json({ error: "not_found" }, 404);

  const [original] = await db
    .select()
    .from(documentFiles)
    .where(and(eq(documentFiles.documentId, id), eq(documentFiles.kind, "original"), eq(documentFiles.isCurrent, true)))
    .limit(1);
  if (!original) return c.json({ error: "original_missing" }, 409);
  // 2026-09-28 原始檔只留 NAS:storage='local' 的文件,顯示檔不再上傳到 R2(R2 不收新檔),
  // 網頁直接顯示 NAS 路徑。回 409 讓判讀端的正規化步驟明確跳過,而不是默默又寫一份進 R2。
  if (original.storage === "local") {
    return c.json(
      { error: "local_storage", message: "這份文件的原始檔只留 NAS(storage=local),顯示檔不再上傳。" },
      409,
    );
  }

  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const currentNormalized = await db
    .select()
    .from(documentFiles)
    .where(and(eq(documentFiles.documentId, id), eq(documentFiles.kind, "normalized_pdf"), eq(documentFiles.isCurrent, true)));
  if (currentNormalized.some((f) => f.sha256 === sha256)) {
    return c.json({ ok: true, unchanged: true, sha256, byteSize: bytes.byteLength });
  }

  const baseName = original.originalFileName.replace(/\.[^.]+$/, "");
  const safeName = `${baseName}.normalized.pdf`.replace(/[^\w.\-\u4e00-\u9fff]/g, "_");
  const r2Key = `documents/${id}/normalized/${sha256.slice(0, 16)}/${safeName}`;
  await c.env.FILES.put(r2Key, bytes, { httpMetadata: { contentType: "application/pdf" } });

  await db.batch([
    db
      .update(documentFiles)
      .set({ isCurrent: false })
      .where(and(eq(documentFiles.documentId, id), eq(documentFiles.kind, "normalized_pdf"), eq(documentFiles.isCurrent, true))),
    db.insert(documentFiles).values({
      documentId: id,
      kind: "normalized_pdf",
      r2Key,
      originalFileName: `${baseName}.pdf`,
      mimeType: "application/pdf",
      byteSize: bytes.byteLength,
      sha256,
      isCurrent: true,
    }),
  ]);

  await db.insert(activityLog).values({
    entityType: "document",
    entityId: id,
    kind: "ocr",
    text: `上傳正規化顯示檔(裁切空白/轉正):${Math.round(original.byteSize / 1024)} KB → ${Math.round(bytes.byteLength / 1024)} KB,原檔保留`,
    actorMemberId: null,
  });

  return c.json({ ok: true, unchanged: false, sha256, byteSize: bytes.byteLength, originalByteSize: original.byteSize, r2Key }, 201);
});
