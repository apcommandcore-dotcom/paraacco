// NAS 原始檔歸檔回寫(2026-09-28,CODE_TASK_local-originals-nas-path_20260927_V1.01.md 第三節 3)——
// 檔案本身由本機腳本(scripts/archive.py、scripts/batch-ingest_V1.03.sh)在 NAS 上搬移/改名,
// 這裡只更新 document_files.local_path,並寫 activity_log。走寫回密鑰
// (middleware/extraction-writeback-auth.ts,X-Extraction-Writeback-Token),跟擷取寫回同一組:
// 兩者都是「本機腳本改既有文件的紀錄」,權限範圍相同。/api/archive/* 一樣需要 Cloudflare Access
// Bypass 政策(做法見 routes/batch-import.ts 開頭說明)。
//
// 規則:
//   - 只接受 storage='local' 的目前生效 original。
//   - fromPath 必須等於目前的 local_path、sha256 必須等於登記的 sha256,才更新——腳本端搬檔前後
//     都驗過 SHA-256,這裡再確認一次「紀錄跟腳本看到的是同一個檔案」,防止用舊計畫檔覆蓋新狀態。
//   - 冪等:local_path 已經等於 toPath(上一次回寫其實成功、只是腳本沒收到回應)直接回 ok。
//   - 批次版一次最多 50 筆,先全部驗證,有任何一筆不合就整批不寫(409 + 每筆原因);
//     驗證通過後包成單一 db.batch()(D1 batch 是單一交易,要嘛全部生效、要嘛全部不生效)。
//     D1 寫入失敗(含每日額度用完)回 503,腳本收到非 2xx 一律把這批已搬的檔案搬回原位。
//   - filed_at:toPath 落在正式位置(10_–90_ 開頭的主體/無法處理資料夾)時寫入時間;搬回 00_收件
//     (回滾)時清成 null。

import { Hono } from "hono";
import { and, asc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { activityLog, createDb, documentFiles, documentPurchaseLinks, documents, purchaseAttachments, vendors } from "@paraacco/db";
import { MANAGED_ROOT, validateLocalPath } from "@paraacco/shared";
import type { Bindings } from "../bindings";
import { createObject, ObjectError } from "../purchase-objects";

export const archiveRoute = new Hono<{ Bindings: Bindings }>();

export const MAX_MOVES_PER_BATCH = 50;
const SHA256_RE = /^[0-9a-f]{64}$/;
const FILED_DIR_RE = new RegExp(`^${MANAGED_ROOT}/(10|20|30|80|90)_[^/]+/`);

interface MoveInput {
  documentId: string;
  fromPath: string;
  toPath: string;
  sha256: string;
}

type MoveCheck =
  | { ok: true; move: MoveInput; fileId: number; unchanged: boolean }
  | { ok: false; documentId: string; error: string; message: string };

function parseMove(raw: unknown, documentIdOverride?: string): MoveInput | { error: string; message: string } {
  if (!raw || typeof raw !== "object") return { error: "invalid_move", message: "每筆必須是物件" };
  const r = raw as Record<string, unknown>;
  const documentId = documentIdOverride ?? r.documentId;
  if (typeof documentId !== "string" || !documentId) return { error: "invalid_document_id", message: "缺 documentId" };
  // 2026-09-28(V1.03):證券對帳單移出系統,目的地可以是 _系統外資料/;回滾時 fromPath 也可能在那裡。
  const fromErr = validateLocalPath(r.fromPath, { allowOutside: true });
  if (fromErr) return { error: "invalid_from_path", message: fromErr };
  const toErr = validateLocalPath(r.toPath, { allowOutside: true });
  if (toErr) return { error: "invalid_to_path", message: toErr };
  if (typeof r.sha256 !== "string" || !SHA256_RE.test(r.sha256)) return { error: "invalid_sha256", message: "sha256 必須是 64 碼小寫十六進位" };
  return { documentId, fromPath: r.fromPath as string, toPath: r.toPath as string, sha256: r.sha256 };
}

async function checkMove(db: ReturnType<typeof createDb>, move: MoveInput): Promise<MoveCheck> {
  const [file] = await db
    .select()
    .from(documentFiles)
    .where(and(eq(documentFiles.documentId, move.documentId), eq(documentFiles.kind, "original"), eq(documentFiles.isCurrent, true)))
    .limit(1);
  const fail = (error: string, message: string): MoveCheck => ({ ok: false, documentId: move.documentId, error, message });
  if (!file) return fail("not_found", "找不到這份文件目前生效的原始檔");
  if (file.storage !== "local") return fail("not_local", "這份文件的原始檔不是 storage=local");
  if (file.sha256 !== move.sha256) return fail("sha256_mismatch", `SHA-256 與登記值不符(登記 ${file.sha256 ?? "null"})`);
  if (file.localPath === move.toPath) return { ok: true, move, fileId: file.id, unchanged: true };
  if (file.localPath !== move.fromPath) return fail("from_path_mismatch", `fromPath 與目前紀錄不符(目前 ${file.localPath ?? "null"})`);
  return { ok: true, move, fileId: file.id, unchanged: false };
}

function buildStatements(db: ReturnType<typeof createDb>, checks: Extract<MoveCheck, { ok: true }>[], now: string) {
  return checks
    .filter((c) => !c.unchanged)
    .flatMap(({ move, fileId }) => [
      db.update(documentFiles).set({ localPath: move.toPath }).where(eq(documentFiles.id, fileId)),
      db
        .update(documents)
        .set({ filedAt: FILED_DIR_RE.test(move.toPath) ? now : null, updatedAt: now })
        .where(eq(documents.id, move.documentId)),
      db.insert(activityLog).values({
        entityType: "document",
        entityId: move.documentId,
        kind: "archive",
        text: `NAS 原始檔搬移:${move.fromPath} → ${move.toPath}`,
        actorMemberId: null,
      }),
    ]);
}

async function applyMoves(db: ReturnType<typeof createDb>, checks: Extract<MoveCheck, { ok: true }>[]) {
  const statements = buildStatements(db, checks, new Date().toISOString());
  if (statements.length) {
    await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
  }
}

function writeFailed(err: unknown) {
  return {
    error: "write_failed",
    message: err instanceof Error ? err.message : String(err),
  };
}

// 讀取目前狀態(給 archive.py 在回應不明確時對帳、integrity_check.py 逐筆核對、archive.py --source api
// 產生歸檔計畫用)。?ids=A,B(最多 50)或分頁 ?after=<DOC id>&limit=<≤500>;只列 storage='local' 的原始檔。
// 附上命名需要的欄位(單據日期、對象、金額、歸屬、買方統編、單據類型標籤)。
// 外層欄位寫成 "documents"."id"(drizzle 在 select 裡會把 ${documents.id} 渲染成不帶表名的 "id",被子查詢的表吃掉)。
const fieldValue = (key: string) =>
  sql<string | null>`(SELECT e.value FROM document_extracted_fields e WHERE e.document_id = "documents"."id" AND e.field_key = ${key})`;

archiveRoute.get("/documents", async (c) => {
  const idsRaw = c.req.query("ids");
  const ids = idsRaw ? idsRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;
  if (ids && ids.length > MAX_MOVES_PER_BATCH) return c.json({ error: "too_many_ids", max: MAX_MOVES_PER_BATCH }, 400);
  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 200;
  const after = c.req.query("after") ?? "";

  const db = createDb(c.env.DB);
  const rows = await db
    .select({
      documentId: documents.id,
      status: documents.status,
      ownership: documents.ownership,
      ownershipConfirmed: documents.ownershipConfirmed,
      docTypeCode: documents.docTypeCode,
      docDate: documents.docDate,
      invoiceDate: documents.invoiceDate,
      vendorNameRaw: documents.vendorNameRaw,
      amountCents: documents.amountCents,
      currency: documents.currency,
      displayName: documents.displayName,
      archivedAt: documents.archivedAt,
      filedAt: documents.filedAt,
      projectCode: documents.projectCode,
      localPath: documentFiles.localPath,
      sha256: documentFiles.sha256,
      byteSize: documentFiles.byteSize,
      originalFileName: documentFiles.originalFileName,
      buyerTaxId: fieldValue("buyerTaxId"),
      invoicePeriod: fieldValue("invoicePeriod"),
      financeDocType: fieldValue("finance_doc_type"),
      entityId: fieldValue("entity_id"),
      // 2026-09-29(CODE_TASK_vendor-name-from-taxid_20260929.md):NAS 檔名的「對象」一律用主檔名稱,
      // archive.py V1.03 沒有 vendorId 的文件不歸檔、不改名(列進 vendor-pending)。
      vendorId: documents.vendorId,
      vendorName: vendors.name,
      vendorTaxId: fieldValue("vendorTaxId"),
      vendorTaxIdQr: fieldValue("vendorTaxIdQr"),
      vendorTaxIdPrinted: fieldValue("vendorTaxIdPrinted"),
      vendorTaxIdSource: fieldValue("vendorTaxIdSource"),
      vendorStatus: fieldValue("vendor_status"),
    })
    .from(documents)
    .leftJoin(vendors, eq(vendors.id, documents.vendorId))
    .innerJoin(
      documentFiles,
      and(
        eq(documentFiles.documentId, documents.id),
        eq(documentFiles.kind, "original"),
        eq(documentFiles.isCurrent, true),
        eq(documentFiles.storage, "local"),
      ),
    )
    .where(ids ? inArray(documents.id, ids) : gt(documents.id, after))
    .orderBy(asc(documents.id))
    .limit(ids ? MAX_MOVES_PER_BATCH : limit);

  return c.json({ documents: rows, next: !ids && rows.length === limit ? rows[rows.length - 1].documentId : null });
});

// ---------------------------------------------------------------------------
// 物件(2026-09-29,CODE_TASK_purchase-object-merge-docs_20260929_V1.01.md)——本機腳本用,驗證同寫回密鑰。
//   GET  /api/archive/objects                 物件成員(主文件/附件類型/品項層)+ 非單據附件,archive.py --source attachments
//                                             依此產生附件改名計畫 <主文件檔名去副檔名>_附件_<類型>_<序號>.<ext>
//   POST /api/archive/purchase-objects        回溯合併:Theo 在 merge-suggestions TSV 勾選後,scripts/merge_objects.py 逐筆送來建物件
//                                             { objects: [{ primaryDocumentId, attachments: [{ documentId, role?, itemLineNo? }], note? }] }(一次 ≤ 20)
// ---------------------------------------------------------------------------
archiveRoute.get("/objects", async (c) => {
  const db = createDb(c.env.DB);
  const [links, extra] = await Promise.all([
    db
      .select({
        purchaseId: documentPurchaseLinks.purchaseId,
        documentId: documentPurchaseLinks.documentId,
        relationKind: documentPurchaseLinks.relationKind,
        attachmentRole: documentPurchaseLinks.attachmentRole,
        purchaseItemId: documentPurchaseLinks.purchaseItemId,
        localPath: documentFiles.localPath,
        sha256: documentFiles.sha256,
        storage: documentFiles.storage,
      })
      .from(documentPurchaseLinks)
      .leftJoin(
        documentFiles,
        and(eq(documentFiles.documentId, documentPurchaseLinks.documentId), eq(documentFiles.kind, "original"), eq(documentFiles.isCurrent, true)),
      )
      .where(ne(documentPurchaseLinks.relationKind, "duplicate_evidence")),
    db.select().from(purchaseAttachments),
  ]);
  return c.json({ links, attachments: extra });
});

archiveRoute.post("/purchase-objects", async (c) => {
  const body = await c.req
    .json<{ objects?: Array<{ primaryDocumentId?: string; attachments?: Array<{ documentId: string; role?: string | null; itemLineNo?: number | null }>; note?: string }> }>()
    .catch(() => null);
  if (!body || !Array.isArray(body.objects) || !body.objects.length) return c.json({ error: "invalid_json", message: "body 必須是 { objects: [...] }" }, 400);
  if (body.objects.length > 20) return c.json({ error: "too_many_objects", max: 20 }, 400);
  const db = createDb(c.env.DB);
  const results: Array<{ primaryDocumentId: string; ok: boolean; purchaseId?: string; error?: string; message?: string }> = [];
  for (const o of body.objects) {
    if (!o.primaryDocumentId) {
      results.push({ primaryDocumentId: "", ok: false, error: "missing_primary" });
      continue;
    }
    try {
      const created = await createObject(db, o.primaryDocumentId, { memberId: null, name: `回溯合併${o.note ? `(${o.note})` : ""}` }, o.attachments ?? [], "import");
      results.push({ primaryDocumentId: o.primaryDocumentId, ok: true, purchaseId: created.purchaseId });
    } catch (err) {
      // 每個物件是獨立的 D1 batch:一個失敗(含 D1 錯誤)只記錄、不中斷,回應一定列出每一筆的結果,腳本的 done 檔才完整。
      results.push({
        primaryDocumentId: o.primaryDocumentId,
        ok: false,
        error: err instanceof ObjectError ? err.code : "write_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return c.json({ ok: results.every((r) => r.ok), results });
});

// 非單據附件(影片/照片)的 NAS 搬移回寫——規則同 /moves:fromPath 要等於目前紀錄,登記過 sha256 的要相符;
// 冪等(已經是 toPath 直接 ok);整批驗證通過才在單一 D1 batch 裡更新。
archiveRoute.post("/attachment-moves", async (c) => {
  const body = await c.req.json<{ moves?: Array<{ attachmentId?: number; fromPath?: string; toPath?: string; sha256?: string }> }>().catch(() => null);
  if (!body || !Array.isArray(body.moves) || !body.moves.length) return c.json({ error: "invalid_json" }, 400);
  if (body.moves.length > MAX_MOVES_PER_BATCH) return c.json({ error: "too_many_moves", max: MAX_MOVES_PER_BATCH }, 400);
  const db = createDb(c.env.DB);
  const rejected: Array<{ attachmentId: unknown; error: string; message: string }> = [];
  const updates: Array<{ id: number; toPath: string; fromPath: string; purchaseId: string }> = [];
  for (const m of body.moves) {
    const err = validateLocalPath(m.toPath, { allowOutside: true }) ?? validateLocalPath(m.fromPath, { allowOutside: true });
    if (!Number.isInteger(m.attachmentId) || err) {
      rejected.push({ attachmentId: m.attachmentId, error: "invalid_move", message: err ?? "attachmentId 必須是整數" });
      continue;
    }
    const [att] = await db.select().from(purchaseAttachments).where(eq(purchaseAttachments.id, m.attachmentId!)).limit(1);
    if (!att) rejected.push({ attachmentId: m.attachmentId, error: "not_found", message: "找不到附件紀錄" });
    else if (att.sha256 && m.sha256 && att.sha256 !== m.sha256) rejected.push({ attachmentId: m.attachmentId, error: "sha256_mismatch", message: `登記 ${att.sha256}` });
    else if (att.localPath === m.toPath) continue;
    else if (att.localPath !== m.fromPath) rejected.push({ attachmentId: m.attachmentId, error: "from_path_mismatch", message: `目前 ${att.localPath}` });
    else updates.push({ id: att.id, toPath: m.toPath!, fromPath: m.fromPath!, purchaseId: att.purchaseId });
  }
  if (rejected.length) return c.json({ error: "rejected", written: 0, rejected }, 409);
  if (updates.length) {
    try {
      await db.batch(
        updates.flatMap((u) => [
          db.update(purchaseAttachments).set({ localPath: u.toPath }).where(eq(purchaseAttachments.id, u.id)),
          db.insert(activityLog).values({ entityType: "purchase", entityId: u.purchaseId, kind: "archive", text: `NAS 附件搬移:${u.fromPath} → ${u.toPath}` }),
        ]) as unknown as Parameters<typeof db.batch>[0],
      );
    } catch (err) {
      return c.json({ ...writeFailed(err), written: 0 }, 503);
    }
  }
  return c.json({ ok: true, written: updates.length });
});

archiveRoute.post("/documents/:id/move", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = parseMove(raw, c.req.param("id"));
  if ("error" in parsed) return c.json(parsed, 400);

  const db = createDb(c.env.DB);
  const check = await checkMove(db, parsed);
  if (!check.ok) return c.json(check, check.error === "not_found" ? 404 : 409);

  try {
    await applyMoves(db, [check]);
  } catch (err) {
    return c.json(writeFailed(err), 503);
  }
  return c.json({ ok: true, documentId: parsed.documentId, localPath: parsed.toPath, unchanged: check.unchanged });
});

archiveRoute.post("/moves", async (c) => {
  const body = await c.req.json<{ moves?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.moves)) return c.json({ error: "invalid_json", message: "body 必須是 { moves: [...] }" }, 400);
  if (body.moves.length === 0) return c.json({ error: "empty_moves" }, 400);
  if (body.moves.length > MAX_MOVES_PER_BATCH) {
    return c.json({ error: "too_many_moves", max: MAX_MOVES_PER_BATCH }, 400);
  }

  const parsed = body.moves.map((m) => parseMove(m));
  const parseErrors = parsed
    .map((p, index) => ("error" in p ? { index, ...p } : null))
    .filter((e) => e !== null);
  if (parseErrors.length) return c.json({ error: "invalid_moves", errors: parseErrors }, 400);
  const moves = parsed as MoveInput[];
  if (new Set(moves.map((m) => m.documentId)).size !== moves.length) {
    return c.json({ error: "duplicate_document_id", message: "同一批不可重複同一份文件" }, 400);
  }

  const db = createDb(c.env.DB);
  const checks = await Promise.all(moves.map((m) => checkMove(db, m)));
  const rejected = checks.filter((ch): ch is Extract<MoveCheck, { ok: false }> => !ch.ok);
  if (rejected.length) return c.json({ error: "rejected", written: 0, rejected }, 409);

  const accepted = checks as Extract<MoveCheck, { ok: true }>[];
  try {
    await applyMoves(db, accepted);
  } catch (err) {
    return c.json({ ...writeFailed(err), written: 0 }, 503);
  }
  return c.json({
    ok: true,
    written: accepted.filter((a) => !a.unchanged).length,
    unchanged: accepted.filter((a) => a.unchanged).map((a) => a.move.documentId),
  });
});
