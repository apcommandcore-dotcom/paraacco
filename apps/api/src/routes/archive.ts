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
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { activityLog, createDb, documentFiles, documents } from "@paraacco/db";
import { MANAGED_ROOT, validateLocalPath } from "@paraacco/shared";
import type { Bindings } from "../bindings";

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
    })
    .from(documents)
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
