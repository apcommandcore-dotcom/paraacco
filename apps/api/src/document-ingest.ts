// 文件登記共用邏輯(documents + document_files + document_processing_job + activity_log +
// 送進 DOCUMENT_QUEUE)——原本只有 routes/documents.ts 的 `POST /api/documents` 一個呼叫端,
// 2026-09-13 新增 routes/batch-import.ts(每日批次進件,見該檔案開頭註解)後抽出來共用,
// 避免兩邊各寫一份、之後改 pipeline 起手式時漏改其中一邊。

import type { Db } from "@paraacco/db";
import { activityLog, documentExtractedFields, documentFiles, documentProcessingJobs, documents, nextId, syncDocumentFts } from "@paraacco/db";
import type { Bindings } from "./bindings";

export const INGEST_CHANNEL_FIELD_KEY = "ingest_channel";

export interface RegisterDocumentInput {
  ownership: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  r2Key: string;
  sha256?: string;
  source: string; // 'web_upload' | 'mobile_scan' | 'email_forward' | 'api_import'
  /** 每日批次進件時填 'local-scanner-batch',標記進件管道用(見 schema.ts sourceCheck 註解:
   * 不新增 source 的合法值,用這個欄位另外標記),不影響上面的 source(一律填既有合法值)。*/
  ingestChannel?: string;
  extractedFields?: Array<{ fieldKey: string; label: string; value?: string; confidence?: number }>;
  /** 建立者,人類上傳時是登入者的 member id;批次進件沒有對應的人類成員,傳 null。 */
  actorMemberId: string | null;
}

export async function registerDocument(db: Db, queue: Bindings["DOCUMENT_QUEUE"], input: RegisterDocumentInput): Promise<string> {
  const year = new Date().getFullYear();
  const id = await nextId(db, "DOC", year);

  await db.insert(documents).values({
    id,
    ownership: input.ownership,
    source: input.source,
    status: "queued",
    createdByMemberId: input.actorMemberId,
  });

  await db.insert(documentFiles).values({
    documentId: id,
    kind: "original",
    r2Key: input.r2Key,
    originalFileName: input.fileName,
    mimeType: input.mimeType,
    byteSize: input.byteSize,
    sha256: input.sha256 ?? null,
  });

  if (input.ingestChannel) {
    await db.insert(documentExtractedFields).values({
      documentId: id,
      fieldKey: INGEST_CHANNEL_FIELD_KEY,
      label: "進件管道",
      value: input.ingestChannel,
      extractionSource: "user_input",
    });
  }

  const jobId = crypto.randomUUID();
  await db.insert(documentProcessingJobs).values({
    id: jobId,
    documentId: id,
    currentStage: 1,
    stageKey: "queued",
    status: "queued",
  });

  if (input.extractedFields?.length) {
    await db.insert(documentExtractedFields).values(
      input.extractedFields.map((f, i) => ({
        documentId: id,
        fieldKey: f.fieldKey,
        label: f.label,
        value: f.value ?? null,
        confidence: f.confidence ?? null,
        extractionSource: "user_input" as const,
        sortOrder: i,
      })),
    );
    await syncDocumentFts(db, id);
  }

  await db.insert(activityLog).values({
    entityType: "document",
    entityId: id,
    kind: "import",
    text: `新文件匯入:${input.fileName}`,
    actorMemberId: input.actorMemberId,
  });

  await queue.send({ documentId: id, reason: "initial" });

  return id;
}
