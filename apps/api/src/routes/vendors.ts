// 供應商主檔 —— 規格 2.6、3.7-2(管理後台「供應商主檔」頁籤 + 新增供應商表單)。
//
// 2026-09-26:輸入統編直接新增供應商——
//   GET  /lookup/:taxId  檢查碼驗證 → 已存在就回既有供應商 → 查經濟部商工登記取得名稱(見 tax-id-lookup.ts)
//   POST /               統編改為先驗證檢查碼、重複統編回 409(原本直接撞 UNIQUE 變 500);
//                        只給 taxId 不給 name 時,伺服器自己查名稱;id 沒給就伺服器產生。

import { Hono } from "hono";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { isValidTaxId, normalizeTaxId } from "@paraacco/domain";
import { activityLog, createDb, documentFiles, documents, recurringSeries, vendors, vendorAliases } from "@paraacco/db";
import { lookupTaxId } from "../tax-id-lookup";
import { backfillVendorIds, listPendingVendors } from "../vendor-resolution";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";

export const vendorsRoute = new Hono<{ Bindings: Bindings }>();

// categoryId 篩選 —— 2026-09-16「依標題瀏覽」入口新增(架構文件:分類→供應商兩層瀏覽,
// 見 paraacco-browse-by-title-design-evaluation-20260916.md 第 1 節)。
vendorsRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const categoryId = c.req.query("categoryId");
  const rows = categoryId
    ? await db.select().from(vendors).where(eq(vendors.defaultCategoryId, categoryId))
    : await db.select().from(vendors);
  const aliasRows = await db.select().from(vendorAliases);
  const withAliases = rows.map((v) => ({
    ...v,
    aliases: aliasRows.filter((a) => a.vendorId === v.id).map((a) => a.alias),
  }));
  return c.json({ vendors: withAliases });
});

vendorsRoute.get("/lookup/:taxId", async (c) => {
  const taxId = normalizeTaxId(c.req.param("taxId"));
  if (!isValidTaxId(taxId)) return c.json({ error: "invalid_tax_id", message: "統一編號格式或檢查碼錯誤" }, 400);

  const db = createDb(c.env.DB);
  const [existing] = await db.select().from(vendors).where(eq(vendors.taxId, taxId)).limit(1);
  if (existing) return c.json({ taxId, exists: true, vendor: existing, registry: null });

  const registry = await lookupTaxId(taxId);
  if (!registry) return c.json({ taxId, exists: false, vendor: null, registry: null, message: "經濟部商工登記查無此統編(可能是機關、學校或免登記的營業人),請手動輸入名稱" });
  return c.json({ taxId, exists: false, vendor: null, registry });
});

function makeVendorId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").slice(0, 40);
  return `vnd-${slug}-${crypto.randomUUID().slice(0, 4)}`;
}

vendorsRoute.post("/", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{
    id?: string;
    name?: string;
    taxId?: string;
    defaultOwnership?: string;
    defaultCategoryId?: string;
    aliases?: string[];
  }>();

  const db = createDb(c.env.DB);
  const taxId = body.taxId ? normalizeTaxId(body.taxId) : null;
  if (taxId) {
    if (!isValidTaxId(taxId)) return c.json({ error: "invalid_tax_id", message: "統一編號格式或檢查碼錯誤" }, 400);
    const [dup] = await db.select().from(vendors).where(eq(vendors.taxId, taxId)).limit(1);
    if (dup) return c.json({ error: "duplicate_tax_id", message: `統編 ${taxId} 已登記為「${dup.name}」`, vendor: dup }, 409);
  }

  let name = body.name?.trim() ?? "";
  let registrySource: string | null = null;
  if (!name && taxId) {
    const hit = await lookupTaxId(taxId);
    if (hit) {
      name = hit.name;
      registrySource = hit.source;
    }
  }
  if (!name) return c.json({ error: "missing_name", message: "查不到登記名稱,請手動輸入名稱" }, 400);

  const ownership = body.defaultOwnership ?? "corp";
  if (ownership !== "per" && ownership !== "corp") return c.json({ error: "invalid_ownership" }, 400);

  const id = body.id ?? makeVendorId(name);
  await db.insert(vendors).values({
    id,
    name,
    taxId,
    defaultOwnership: ownership,
    defaultCategoryId: body.defaultCategoryId ?? null,
  });

  if (body.aliases?.length) {
    await db.insert(vendorAliases).values(body.aliases.map((alias) => ({ vendorId: id, alias })));
  }

  // R-V4(CODE_TASK_vendor-name-from-taxid_20260929.md):建檔成功後,把同統編、還在待建檔的文件補上 vendorId。
  // NAS 歸檔/改名由本機 archive.py 接手(Worker 碰不到 NAS)。補對應失敗不影響建檔本身(每日排程會再跑一次)。
  let linkedDocumentIds: string[] = [];
  if (taxId) {
    try {
      const hits = await backfillVendorIds(db, { onlyTaxId: taxId, actorMemberId: auth.memberId, actorName: auth.name ?? auth.email ?? null });
      linkedDocumentIds = hits.map((h) => h.documentId);
    } catch (err) {
      console.error("backfillVendorIds failed", err);
    }
  }

  return c.json({ ok: true, id, name, taxId, registrySource, linkedDocumentIds }, 201);
});

// 待建檔供應商(R-V3)——統編有效但未建檔的文件依統編彙總(同一統編一行),另列統編無法辨識的文件。
// 處理中心「待建檔供應商」分頁用;本機 archive.py --source audit 產出的 vendor-pending_*.tsv 是同一份規則。
vendorsRoute.get("/pending", async (c) => {
  const db = createDb(c.env.DB);
  return c.json(await listPendingVendors(db));
});

// 修改主檔名稱(2026-09-29,CODE_TASK_vendor-name-from-taxid_20260929.md R-V4 末段)——只更新 D1 顯示名稱;
// NAS 檔名不自動改,回傳「已歸檔、檔名用到這個供應商」的影響清單,由 Theo 確認後跑
// `archive.py --source audit` 產生 rename-plan 再 --apply。統編不在這裡改(改統編等於換一家供應商)。
vendorsRoute.post("/:id", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const name = body.name?.trim() ?? "";
  if (!name) return c.json({ error: "missing_name" }, 400);

  const db = createDb(c.env.DB);
  const [existing] = await db.select().from(vendors).where(eq(vendors.id, id)).limit(1);
  if (!existing) return c.json({ error: "not_found" }, 404);
  if (existing.name === name) return c.json({ ok: true, unchanged: true, nasRenameCandidates: [] });

  await db.batch([
    db.update(vendors).set({ name }).where(eq(vendors.id, id)),
    db.insert(activityLog).values({
      entityType: "vendor",
      entityId: id,
      kind: "review",
      text: `${auth.name ?? auth.email ?? "系統"} 修改供應商主檔名稱:「${existing.name}」→「${name}」(NAS 檔名未自動改)`,
      actorMemberId: auth.memberId,
    }),
  ]);
  const affected = await db
    .select({ documentId: documents.id, localPath: documentFiles.localPath })
    .from(documents)
    .innerJoin(documentFiles, and(eq(documentFiles.documentId, documents.id), eq(documentFiles.kind, "original"), eq(documentFiles.isCurrent, true)))
    .where(and(eq(documents.vendorId, id), isNotNull(documents.filedAt)));
  return c.json({
    ok: true,
    previousName: existing.name,
    name,
    nasRenameCandidates: affected,
    message: affected.length
      ? `已更新顯示名稱。已歸檔的 ${affected.length} 份 NAS 檔名沒有自動改,確認後請用 archive.py --source audit 產生 rename-plan。`
      : "已更新顯示名稱。",
  });
});

vendorsRoute.get("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const id = c.req.param("id");
  const [row] = await db.select().from(vendors).where(eq(vendors.id, id)).limit(1);
  if (!row) return c.json({ error: "not_found" }, 404);
  const aliasRows = await db.select().from(vendorAliases).where(eq(vendorAliases.vendorId, id));
  return c.json({ vendor: row, aliases: aliasRows.map((a) => a.alias) });
});
