// DocumentProcessingWorkflow —— 8 步驟文件處理管線的 Cloudflare Workflow 實作(見範圍決策:
// 現在就導入 Queues + Workflows,取代 v1 apps/api 同步處理 /ocr-result 的設計)。
//
// 每個 step.do() 都是獨立、可重試、結果會被快取的durable step —— 如果 Workflow 在某一步
// 之後失敗重跑,前面已完成的 step 不會重新執行,直接用快取結果,這也是選用 Workflows 而不是
// 自己手刻重試邏輯的主要理由。
//
// 業務規則(供應商強制覆核、關聯評分/決標、重複偵測、欄位加權信心分數)全部在 apps/api 的
// /internal/* 端點或 @paraacco/domain 執行,這裡只負責照順序呼叫、把 OCR provider 的原始
// 結果傳過去、依回傳結果決定下一步——維持「document-worker 不自己判斷業務規則」的分工原則。

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { calculateOverallConfidence, isExternalExtractionField, type FieldConfidenceInput } from "@paraacco/domain";
import { GeminiOcrProvider, type OcrExtractionResult, type OcrProvider } from "@paraacco/ocr";
import type { Bindings, DocumentWorkflowParams } from "./bindings";
import { callInternal } from "./internal-client";

// 實際 OCR/欄位擷取供應商(2026-09-04 決策,取代先前的 MockOcrProvider 佔位——
// MockOcrProvider、CloudflareWorkersAiOcrProvider 仍保留在 @paraacco/ocr,供備援/本機測試
// 切換回去用。見 GeminiOcrProvider 檔案開頭註解:選型理由、費用、信心分數是保守固定基準值,
// 待真實單據測試後再調整。
function createOcrProvider(env: Bindings): OcrProvider {
  return new GeminiOcrProvider({ apiKey: env.GEMINI_API_KEY });
}

// EXTRACTION_MODE 開關(2026-09-23,見 CODE_TASK_extraction-writeback-api_20260923.md、
// CODE_REPORT_extraction-writeback-api-phase2-proposals_20260923.md 提案 2)——
// 'gemini' 才是「呼叫 Gemini」,其他任何值(含未設定、打錯字)一律當成 'external'。刻意
// 設計成「設定壞掉時誤停 Gemini,不會誤呼叫 Gemini」的安全方向,避免打錯字意外燒到
// Gemini 額度/費用。
function resolveExtractionMode(env: Bindings): "gemini" | "external" {
  return env.EXTRACTION_MODE === "gemini" ? "gemini" : "external";
}

interface DocumentFileRow {
  id: number;
  documentId: string;
  kind: string;
  r2Key: string;
  /** 2026-09-28(migration 0009):'local' = 原始檔只在 NAS,R2 沒有這個物件(r2Key 只是佔位值)。 */
  storage?: string;
  originalFileName: string;
  mimeType: string;
  byteSize: number;
  sha256: string | null;
  pageNumber: number | null;
  isCurrent: boolean;
}

interface DocumentRow {
  id: string;
  ownership: string;
  status: string;
  [key: string]: unknown;
}

// document_extracted_fields 的一列 —— 人工 OCR(md 交接)接回 pipeline 用,見
// CODE_TASK_manual-ocr-pipeline-integration_20260904.md。
interface ExtractedFieldRow {
  fieldKey: string;
  label: string;
  value: string | null;
  confidence: number | null;
  extractionSource: string;
  sourceNote: string | null;
}

interface DocumentDetailResponse {
  document: DocumentRow;
  files: DocumentFileRow[];
  fields: ExtractedFieldRow[];
}

interface OriginalFileRef {
  r2Key: string;
  storage: string;
  mimeType: string;
  originalFileName: string;
  sha256: string | null;
}

interface CandidateResult {
  kind: "purchase" | "asset" | "document";
  id: string;
  score: number;
  autoLink: boolean;
}

interface ComputeCandidatesResponse {
  candidates: CandidateResult[];
  autoLink: CandidateResult | null;
}

interface VendorCheckResponse {
  matchedVendorId: string | null;
  forcedReview: boolean;
  /** 2026-09-29(CODE_TASK_vendor-name-from-taxid_20260929.md):只用賣方統編比對。舊版 API 沒有這兩欄。 */
  vendorStatus?: "matched" | "pending" | "taxid_unreadable";
  vendorTaxId?: string | null;
}

interface ClassifyResponse {
  ok: true;
  /** scope 判斷不足或金額缺漏(見 @paraacco/domain 的 classifyDocument()),不管分數/供應商
   * 主檔比對結果如何,一律強制送人工覆核。 */
  forceReview: boolean;
}

async function logEvent(
  env: Bindings,
  jobId: string,
  stageNumber: number,
  stageKey: string,
  eventType: "started" | "completed" | "skipped" | "failed",
  detail?: unknown,
): Promise<void> {
  await callInternal(env, "POST", `/internal/jobs/${jobId}/events`, {
    stageNumber,
    stageKey,
    eventType,
    detailJson: detail !== undefined ? JSON.stringify(detail) : undefined,
  });
}

async function updateJob(env: Bindings, jobId: string, patch: Record<string, unknown>): Promise<void> {
  await callInternal(env, "POST", `/internal/jobs/${jobId}`, patch);
}

export class DocumentProcessingWorkflow extends WorkflowEntrypoint<Bindings, DocumentWorkflowParams> {
  async run(event: WorkflowEvent<DocumentWorkflowParams>, step: WorkflowStep): Promise<unknown> {
    const { documentId, jobId } = event.payload;
    const env = this.env;
    const ocrProvider = createOcrProvider(env);

    try {
      // 階段 1(queued):Workflow 實例本身被建立、開始執行就代表這步完成,只需要記錄。
      await step.do("stage-1-queued", async () => {
        await logEvent(env, jobId, 1, "queued", "started");
        await updateJob(env, jobId, { currentStage: 1, stageKey: "queued" });
        await logEvent(env, jobId, 1, "queued", "completed");
      });

      // 階段 2(validating):取得文件 + 原始檔案 metadata,若有 sha256 就做重複偵測。
      // 只把 step 需要的最小、明確可序列化的欄位傳出 step.do() 邊界(Workflow 的
      // step.do() 回傳值會被序列化快取,不接受帶 index signature 的寬鬆型別)。
      const { original, duplicateOfDocumentId, userInputFields } = await step.do("stage-2-validating", async () => {
        await logEvent(env, jobId, 2, "validating", "started");
        await updateJob(env, jobId, { currentStage: 2, stageKey: "validating" });

        const detail = await callInternal<DocumentDetailResponse>(env, "GET", `/internal/documents/${documentId}`);
        const originalFile = detail.files.find((f) => f.kind === "original" && f.isCurrent);
        if (!originalFile) {
          throw new Error(`document ${documentId} has no original file registered`);
        }
        const original: OriginalFileRef = {
          r2Key: originalFile.r2Key,
          storage: originalFile.storage ?? "r2",
          mimeType: originalFile.mimeType,
          originalFileName: originalFile.originalFileName,
          sha256: originalFile.sha256,
        };

        let duplicateOfDocumentId: string | null = null;
        if (original.sha256) {
          const dup = await callInternal<{ duplicateOfDocumentId: string | null }>(
            env,
            "POST",
            `/internal/documents/${documentId}/duplicate-check`,
            { sha256: original.sha256 },
          );
          duplicateOfDocumentId = dup.duplicateOfDocumentId;
        }

        // 人工 OCR(md 交接)或外部寫回(POST /api/extraction-writeback/documents/:id,見
        // CODE_TASK_extraction-writeback-api_20260923.md)接回 pipeline:有真的擷取結果的話,
        // 階段 3 完全不呼叫 Gemini,直接用這些欄位組結果(見下方 stage-3-ocr)。用
        // isExternalExtractionField()(@paraacco/domain)判斷,不是只看 extractionSource ——
        // 排除 ingest_channel 之類的系統標記欄位,也排除 pipeline 自己這次/上次跑出來的
        // ai_inference 欄位(外部寫回一樣標 ai_inference,只能靠 sourceNote 前綴區分,見該
        // function 的註解)。
        const userInputFields = detail.fields.filter(isExternalExtractionField);

        await logEvent(env, jobId, 2, "validating", "completed", { duplicateOfDocumentId });
        return { original, duplicateOfDocumentId, userInputFields };
      });

      if (duplicateOfDocumentId) {
        await step.do("stage-8-decision-dup", async () => {
          await callInternal(env, "POST", `/internal/documents/${documentId}/decide`, {
            status: "dup",
            note: `偵測到與 ${duplicateOfDocumentId} 檔案內容相同(SHA-256 相符)`,
          });
          await updateJob(env, jobId, { currentStage: 8, stageKey: "decision", status: "completed", completedAt: new Date().toISOString() });
        });
        return { status: "dup", duplicateOfDocumentId };
      }

      // 階段 3(ocr):優先用人工 OCR(md 交接)/外部寫回的欄位,完全不呼叫 Gemini;都沒有的話
      // 再看 EXTRACTION_MODE——'external' 時一樣不呼叫 Gemini,只留一筆明確的佔位紀錄,等
      // 外部寫回;'gemini'(或都不是上述情況)才照原本邏輯把原始檔案從 R2 讀出來,交給 OCR
      // provider(見 CODE_TASK_manual-ocr-pipeline-integration_20260904.md、
      // CODE_TASK_extraction-writeback-api_20260923.md)。
      const ocrResult = await step.do("stage-3-ocr", async () => {
        await logEvent(env, jobId, 3, "ocr", "started");
        await updateJob(env, jobId, { currentStage: 3, stageKey: "ocr" });

        if (userInputFields.length) {
          const result = fieldsToExtractionResult(userInputFields);
          await logEvent(env, jobId, 3, "ocr", "skipped", {
            reason: "external extraction fields present",
            fieldCount: result.fields.length,
          });
          return result;
        }

        // 2026-09-28:原始檔只留 NAS(storage='local')時 Worker 讀不到檔案,不管 EXTRACTION_MODE
        // 是什麼一律走外部判讀——不然 'gemini' 模式會去 R2 讀佔位 key、整個 job 失敗。
        if (resolveExtractionMode(env) === "external" || original.storage === "local") {
          // 不讀 R2 檔案、不呼叫 Gemini——現階段擷取由外部進行,雲端不該花 Gemini 額度/費用。
          // _ocr_status 這個 fieldKey 不是新發明,沿用 @paraacco/ocr 的
          // unsupportedResult()(packages/ocr/src/shared.ts)已經在用的「沒有真的擷取到、
          // 需要另外處理」佔位慣例。這個值(awaiting_external_extraction)刻意跟低信心/失敗
          // 共用同一個 _ocr_status fieldKey 但用不同的固定值,不跟低信心/失敗共用同一個值
          // ——「待外部擷取」是待處理佇列,「低信心」是待人工判斷佇列,兩者是不同的工作,
          // 混在一起就會重演 CODE_REPORT_batch-ingest-no-ocr-207docs-root-cause_20260922.md
          // 那種「看起來都一樣、實際狀態不同」的問題。這個值不在 REAL_EXTRACTION_FIELD_KEYS
          // 白名單內,不影響 Q3 決議的「待擷取文件」查詢(有原檔、無白名單欄位)。
          await logEvent(env, jobId, 3, "ocr", "skipped", {
            reason: original.storage === "local" ? "original_on_nas" : "extraction_mode_external",
          });
          const placeholder: OcrExtractionResult = {
            fields: [
              {
                fieldKey: "_ocr_status",
                label: "OCR 狀態",
                value: "awaiting_external_extraction",
                confidence: 0,
                extractionSource: "ai_inference",
                sourceNote: `EXTRACTION_MODE=external(${new Date().toISOString()})`,
              },
            ],
          };
          return placeholder;
        }

        const obj = await env.FILES.get(original.r2Key);
        if (!obj) throw new Error(`R2 object missing: ${original.r2Key}`);
        const fileBytes = await obj.arrayBuffer();

        const result = await ocrProvider.extract({
          documentId,
          fileBytes,
          mimeType: original.mimeType,
          fileName: original.originalFileName,
        });

        await logEvent(env, jobId, 3, "ocr", "completed", { fieldCount: result.fields.length });
        return result;
      });

      // 階段 4(extract):把 OCR 擷取到的欄位寫進 document_extracted_fields。
      //
      // 2026-09-23 修正:userInputFields.length 的分支(人工/外部寫回已經有欄位)不能呼叫
      // /internal/documents/:id/fields —— 那個端點是「整份文件先刪全部既有欄位、再插入傳
      // 進來的」語意(見 apps/api/src/routes/internal/documents.ts 該端點註解),而
      // fieldsToExtractionResult() 組出來的 ocrResult.fields 只涵蓋 REAL_EXTRACTION_FIELD_KEYS
      // 白名單內的欄位鍵——外部寫回端點另外寫的 SPEC 擴充欄位(taxable_amount/seller_tax_id/
      // machine_no/line_items 等,不在白名單內,故意不 promote 到 documents 直欄)重跑到這裡
      // 會被整批刪掉。這些欄位本來就已經正確地在 DB 裡(不然 userInputFields 不會有內容),
      // 不需要也不能重寫,直接跳過。
      await step.do("stage-4-extract", async () => {
        await logEvent(env, jobId, 4, "extract", "started");
        await updateJob(env, jobId, { currentStage: 4, stageKey: "extract" });
        if (userInputFields.length) {
          await logEvent(env, jobId, 4, "extract", "skipped", { reason: "fields already present" });
          return;
        }
        await callInternal(env, "POST", `/internal/documents/${documentId}/fields`, { fields: ocrResult.fields });
        await logEvent(env, jobId, 4, "extract", "completed");
      });

      // 階段 5(classifying):促升文件層級欄位到 documents 直欄,並計算整體信心分數
      // (@paraacco/domain 的 calculateOverallConfidence(),必要欄位加權平均,見 confidence.ts)。
      // 2026-09-13 財務文件自動分類新增:一併把 scope/financeDocType/counterparty/
      // classificationConfidence/notes 傳給 /classify,由它算出 ownership、display_name、
      // 是否強制送人工覆核(見 apps/api/src/routes/internal/documents.ts 該端點註解)。
      const classifyResult = await step.do("stage-5-classifying", async () => {
        await logEvent(env, jobId, 5, "classifying", "started");
        await updateJob(env, jobId, { currentStage: 5, stageKey: "classifying" });

        const overallConfidence = calculateOverallConfidence(buildConfidenceInputs(ocrResult));

        const result = await callInternal<ClassifyResponse>(env, "POST", `/internal/documents/${documentId}/classify`, {
          docTypeCode: ocrResult.docTypeCode,
          docDate: ocrResult.docDate,
          invoiceDate: ocrResult.invoiceDate,
          invoiceNo: ocrResult.invoiceNo,
          orderNo: ocrResult.orderNo,
          serialNo: ocrResult.serialNo,
          brand: ocrResult.brand,
          model: ocrResult.model,
          itemName: ocrResult.itemName,
          amountCents: ocrResult.amountCents,
          currency: ocrResult.currency,
          vendorNameRaw: ocrResult.vendorNameRaw,
          ocrConfidence: overallConfidence,
          scope: ocrResult.scope,
          financeDocType: ocrResult.financeDocType,
          counterparty: ocrResult.counterparty,
          classificationConfidence: ocrResult.classificationConfidence,
          notes: ocrResult.notes,
        });

        await logEvent(env, jobId, 5, "classifying", "completed", { overallConfidence, forceReview: result.forceReview });
        return result;
      });

      // 階段 6(matching):對既有 purchases/assets 評分,落地存候選、試著決標。
      const matchResult = await step.do("stage-6-matching", async () => {
        await logEvent(env, jobId, 6, "matching", "started");
        await updateJob(env, jobId, { currentStage: 6, stageKey: "matching" });
        const result = await callInternal<ComputeCandidatesResponse>(
          env,
          "POST",
          `/internal/documents/${documentId}/compute-candidates`,
          {},
        );
        await logEvent(env, jobId, 6, "matching", "completed", {
          candidateCount: result.candidates.length,
          autoLink: result.autoLink,
        });
        return result;
      });

      // 階段 7(vendor_check):供應商主檔強制覆核規則,獨立於分數之外。
      const vendorCheck = await step.do("stage-7-vendor-check", async () => {
        await logEvent(env, jobId, 7, "vendor_check", "started");
        await updateJob(env, jobId, { currentStage: 7, stageKey: "vendor_check" });
        const result = await callInternal<VendorCheckResponse>(
          env,
          "POST",
          `/internal/documents/${documentId}/vendor-check`,
          {
            vendorNameRaw: ocrResult.vendorNameRaw,
            vendorTaxId: ocrResult.vendorTaxId,
            vendorAliasCandidates: ocrResult.vendorAliasCandidates,
          },
        );
        await logEvent(env, jobId, 7, "vendor_check", "completed", result);
        return result;
      });

      // 階段 8(decision):供應商未登記、或財務分類判斷不足(範圍待確認/CORP-PERS/金額缺漏,
      // 見 classifyResult.forceReview)一律強制送人工覆核,優先於分數;否則若有決標成功的
      // 候選就自動關聯歸檔,三者皆非才送人工覆核(有候選讓人挑,或完全沒候選也要人工建檔)。
      await step.do("stage-8-decision", async () => {
        await logEvent(env, jobId, 8, "decision", "started");
        await updateJob(env, jobId, { currentStage: 8, stageKey: "decision" });

        // userInputFields.length > 0 一律強制 review,不管 matching/vendor-check 結果多好——
        // 這代表這份文件至少有一部分資料是人工/外部寫回的(見 CODE_TASK_
        // extraction-writeback-api_20260923.md 階段二 B 項需求 3:「寫入後文件狀態為
        // review,不得自動 archived」)。內部 Gemini 判讀走的自動決標/歸檔邏輯是針對「這次
        // pipeline 自己跑出來的第一方 OCR 結果」設計、已經跑過驗證的路徑,外部寫回的資料
        // 還沒有同等的信任基礎,不能因為剛好比對到高分候選就跳過人工看一眼。
        const forcedReview = vendorCheck.forcedReview || classifyResult.forceReview || userInputFields.length > 0;

        if (!forcedReview && matchResult.autoLink) {
          await callInternal(env, "POST", `/internal/documents/${documentId}/auto-link`, {
            targetType: matchResult.autoLink.kind,
            targetId: matchResult.autoLink.id,
            score: matchResult.autoLink.score,
          });
          await logEvent(env, jobId, 8, "decision", "completed", { outcome: "auto_link" });
        } else {
          await callInternal(env, "POST", `/internal/documents/${documentId}/decide`, {
            status: "review",
            note: vendorCheck.forcedReview
              ? vendorCheck.vendorStatus === "taxid_unreadable"
                ? "賣方統編無法辨識(讀不到或檢查碼錯誤),列入待建檔清單、不歸檔,強制送人工覆核"
                : vendorCheck.vendorStatus === "pending"
                  ? `賣方統編 ${vendorCheck.vendorTaxId ?? ""} 未建檔,列入待建檔供應商、不歸檔,強制送人工覆核`
                  : "供應商未登記於主檔,強制送人工覆核"
              : classifyResult.forceReview
                ? "財務分類範圍待確認或金額無法辨識,強制送人工覆核"
                : userInputFields.length > 0
                  ? "擷取結果為人工/外部寫回,強制送人工覆核"
                  : matchResult.candidates.length
                    ? "有候選物件但無法自動決標,送人工覆核挑選"
                    : "無關聯候選,需人工建立或連結",
          });
          await logEvent(env, jobId, 8, "decision", "completed", { outcome: "review" });
        }

        await updateJob(env, jobId, { status: "completed", completedAt: new Date().toISOString() });
      });

      return { status: "completed" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await updateJob(env, jobId, { status: "failed", errorMessage: message });
      await callInternal(env, "POST", `/internal/documents/${documentId}/decide`, {
        status: "failed",
        note: `pipeline 處理失敗:${message}`,
      }).catch(() => undefined);
      throw err;
    }
  }
}

// 人工 OCR(md 交接)接回 pipeline:把 document_extracted_fields 裡 extractionSource
// 'user_input' 的欄位轉回 OcrExtractionResult 的頂層摘要欄位形狀 —— 跟
// cloudflare-workers-ai-provider.ts 的 toExtractionResult() 方向相反(那邊是「模型輸出 →
// 攤平成欄位列表」,這裡是「已經存好的欄位列表 → 還原成頂層摘要」),邏輯類似。
function fieldsToExtractionResult(rows: ExtractedFieldRow[]): OcrExtractionResult {
  const byKey = new Map(rows.map((r) => [r.fieldKey, r.value ?? undefined]));
  const amountCentsRaw = byKey.get("amountCents");

  return {
    fields: rows.map((r) => ({
      fieldKey: r.fieldKey,
      label: r.label,
      value: r.value ?? undefined,
      confidence: r.confidence ?? undefined,
      extractionSource: "user_input",
    })),
    vendorNameRaw: byKey.get("vendorNameRaw"),
    vendorTaxId: byKey.get("vendorTaxId"),
    docTypeCode: byKey.get("docTypeCode"),
    docDate: byKey.get("docDate"),
    invoiceDate: byKey.get("invoiceDate"),
    invoiceNo: byKey.get("invoiceNo"),
    orderNo: byKey.get("orderNo"),
    serialNo: byKey.get("serialNo"),
    brand: byKey.get("brand"),
    model: byKey.get("model"),
    itemName: byKey.get("itemName"),
    amountCents: amountCentsRaw !== undefined ? Number(amountCentsRaw) : undefined,
    currency: byKey.get("currency") ?? "TWD",
  };
}

function buildConfidenceInputs(ocrResult: OcrExtractionResult): FieldConfidenceInput[] {
  const byKey = new Map(ocrResult.fields.map((f) => [f.fieldKey, f]));
  const requiredKeys = ["vendorNameRaw", "invoiceNo", "amountCents", "docDate", "orderNo", "serialNo", "brand", "model"];

  return requiredKeys.map((key) => {
    const field = byKey.get(key);
    return {
      fieldKey: key,
      confidence: field?.confidence,
      extractionSource: field?.extractionSource,
      isUserConfirmed: false,
    };
  });
}
