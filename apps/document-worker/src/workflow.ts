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
import { calculateOverallConfidence, type FieldConfidenceInput } from "@paraacco/domain";
import { MockOcrProvider, type OcrExtractionResult, type OcrProvider } from "@paraacco/ocr";
import type { Bindings, DocumentWorkflowParams } from "./bindings";
import { callInternal } from "./internal-client";

// 尚未選定實際 OCR 供應商(規格文件缺口清單第 1 點)—— 見 MockOcrProvider 註解,
// 之後串接實際供應商時只需要換掉這個變數指到新的 OcrProvider 實作。
const ocrProvider: OcrProvider = new MockOcrProvider();

interface DocumentFileRow {
  id: number;
  documentId: string;
  kind: string;
  r2Key: string;
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
}

interface DocumentDetailResponse {
  document: DocumentRow;
  files: DocumentFileRow[];
  fields: ExtractedFieldRow[];
}

interface OriginalFileRef {
  r2Key: string;
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

        // 人工 OCR(md 交接)接回 pipeline:POST /api/documents 建立文件當下如果已經帶了
        // extractedFields,這裡會先看到 extractionSource: 'user_input' 的欄位 —— 有的話
        // 階段 3 完全不呼叫 Workers AI,直接用這些欄位組結果(見下方 stage-3-ocr)。
        const userInputFields = detail.fields.filter((f) => f.extractionSource === "user_input");

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

      // 階段 3(ocr):優先用人工 OCR(md 交接)的欄位,完全不呼叫 Workers AI;沒有的話才
      // 照原本邏輯把原始檔案從 R2 讀出來,交給 OCR provider(見
      // CODE_TASK_manual-ocr-pipeline-integration_20260904.md)。
      const ocrResult = await step.do("stage-3-ocr", async () => {
        await logEvent(env, jobId, 3, "ocr", "started");
        await updateJob(env, jobId, { currentStage: 3, stageKey: "ocr" });

        if (userInputFields.length) {
          const result = fieldsToExtractionResult(userInputFields);
          await logEvent(env, jobId, 3, "ocr", "skipped", {
            reason: "user_input fields present",
            fieldCount: result.fields.length,
          });
          return result;
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
      await step.do("stage-4-extract", async () => {
        await logEvent(env, jobId, 4, "extract", "started");
        await updateJob(env, jobId, { currentStage: 4, stageKey: "extract" });
        await callInternal(env, "POST", `/internal/documents/${documentId}/fields`, { fields: ocrResult.fields });
        await logEvent(env, jobId, 4, "extract", "completed");
      });

      // 階段 5(classifying):促升文件層級欄位到 documents 直欄,並計算整體信心分數
      // (@paraacco/domain 的 calculateOverallConfidence(),必要欄位加權平均,見 confidence.ts)。
      await step.do("stage-5-classifying", async () => {
        await logEvent(env, jobId, 5, "classifying", "started");
        await updateJob(env, jobId, { currentStage: 5, stageKey: "classifying" });

        const overallConfidence = calculateOverallConfidence(buildConfidenceInputs(ocrResult));

        await callInternal(env, "POST", `/internal/documents/${documentId}/classify`, {
          docTypeCode: ocrResult.docTypeCode,
          docDate: ocrResult.docDate,
          invoiceNo: ocrResult.invoiceNo,
          orderNo: ocrResult.orderNo,
          serialNo: ocrResult.serialNo,
          brand: ocrResult.brand,
          model: ocrResult.model,
          amountCents: ocrResult.amountCents,
          currency: ocrResult.currency,
          vendorNameRaw: ocrResult.vendorNameRaw,
          ocrConfidence: overallConfidence,
        });

        await logEvent(env, jobId, 5, "classifying", "completed", { overallConfidence });
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

      // 階段 8(decision):供應商未登記一律強制送人工覆核,優先於分數;否則若有決標成功的
      // 候選就自動關聯歸檔,兩者皆非才送人工覆核(有候選讓人挑,或完全沒候選也要人工建檔)。
      await step.do("stage-8-decision", async () => {
        await logEvent(env, jobId, 8, "decision", "started");
        await updateJob(env, jobId, { currentStage: 8, stageKey: "decision" });

        if (!vendorCheck.forcedReview && matchResult.autoLink) {
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
              ? "供應商未登記於主檔,強制送人工覆核"
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
    invoiceNo: byKey.get("invoiceNo"),
    orderNo: byKey.get("orderNo"),
    serialNo: byKey.get("serialNo"),
    brand: byKey.get("brand"),
    model: byKey.get("model"),
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
