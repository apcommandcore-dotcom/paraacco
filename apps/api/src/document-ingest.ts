// 文件登記共用邏輯(documents + document_files + document_processing_job + activity_log +
// 送進 DOCUMENT_QUEUE)——原本只有 routes/documents.ts 的 `POST /api/documents` 一個呼叫端,
// 2026-09-13 新增 routes/batch-import.ts(每日批次進件,見該檔案開頭註解)後抽出來共用,
// 避免兩邊各寫一份、之後改 pipeline 起手式時漏改其中一邊。

import type { Db } from "@paraacco/db";
import { activityLog, documentExtractedFields, documentFiles, documentProcessingJobs, documents, nextId, syncDocumentFts } from "@paraacco/db";
import { localR2KeyPlaceholder } from "@paraacco/shared";
import type { Bindings } from "./bindings";

export const INGEST_CHANNEL_FIELD_KEY = "ingest_channel";

export interface RegisterDocumentInput {
  ownership: string;
  /** 呼叫端已確認 ownership(非預設佔位值),分類階段不會覆蓋。省略視為 false。 */
  ownershipConfirmed?: boolean;
  fileName: string;
  mimeType: string;
  byteSize: number;
  /** storage='r2'(舊流程)必填;storage='local' 時忽略,改填 localR2KeyPlaceholder() 佔位值。 */
  r2Key?: string;
  sha256?: string;
  /** 2026-09-28 原始檔只留 NAS:'local' 時不寫 R2,檔案位置記在 localPath(相對於 LOCAL_ROOT)。
   * 省略視為 'r2'(舊文件、測試)。 */
  storage?: "r2" | "local";
  /** storage='local' 必填,已由呼叫端用 validateLocalPath() 驗證過。可含 `{id}`,登記時換成配到的
   * DOC id(每日進件先登記、再把 NAS 上的檔案改名成 DOC-….pdf,省一次回寫,見 routes/batch-import.ts)。 */
  localPath?: string;
  source: string; // 'web_upload' | 'mobile_scan' | 'email_forward' | 'api_import'
  /** 每日批次進件時填 'local-scanner-batch',標記進件管道用(見 schema.ts sourceCheck 註解:
   * 不新增 source 的合法值,用這個欄位另外標記),不影響上面的 source(一律填既有合法值)。*/
  ingestChannel?: string;
  extractedFields?: Array<{ fieldKey: string; label: string; value?: string; confidence?: number }>;
  /** 建立者,人類上傳時是登入者的 member id;批次進件沒有對應的人類成員,傳 null。 */
  actorMemberId: string | null;
}

export async function registerDocument(db: Db, queue: Bindings["DOCUMENT_QUEUE"], input: RegisterDocumentInput): Promise<string> {
  return (await registerDocumentDetailed(db, queue, input)).id;
}

/** 同 registerDocument(),另外回傳實際寫入的 localPath(`{id}` 已替換)。 */
export async function registerDocumentDetailed(
  db: Db,
  queue: Bindings["DOCUMENT_QUEUE"],
  input: RegisterDocumentInput,
): Promise<{ id: string; localPath: string | null }> {
  const year = new Date().getFullYear();
  const id = await nextId(db, "DOC", year);

  await db.insert(documents).values({
    id,
    ownership: input.ownership,
    ownershipConfirmed: input.ownershipConfirmed ?? false,
    source: input.source,
    status: "queued",
    createdByMemberId: input.actorMemberId,
  });

  const storage = input.storage ?? "r2";
  if (storage === "r2" && !input.r2Key) throw new Error("registerDocument: storage='r2' 需要 r2Key");
  if (storage === "local" && !input.localPath) throw new Error("registerDocument: storage='local' 需要 localPath");
  const localPath = storage === "local" ? input.localPath!.replaceAll("{id}", id) : null;

  await db.insert(documentFiles).values({
    documentId: id,
    kind: "original",
    r2Key: storage === "local" ? localR2KeyPlaceholder(id) : input.r2Key!,
    storage,
    localPath,
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

  return { id, localPath };
}
