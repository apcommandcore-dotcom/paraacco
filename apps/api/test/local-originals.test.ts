// 原始檔只留 NAS、歸檔回寫、定期帳單月份檢核(CODE_TASK_local-originals-nas-path_20260927_V1.01.md)。

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  activityLog,
  createDb,
  documentCaseLinks,
  documentFiles,
  documents,
  members,
  recurringSeries,
} from "@paraacco/db";
import type { Bindings } from "../src/bindings";
import { batchImportRoute } from "../src/routes/batch-import";
import { archiveRoute } from "../src/routes/archive";
import { documentsRoute } from "../src/routes/documents";
import { extractionWritebackRoute } from "../src/routes/extraction-writeback";
import { recurringRoute } from "../src/routes/recurring";
import { uploadsRoute } from "../src/routes/uploads";
import { TEST_AUTH } from "./helpers";

const app = new Hono<{ Bindings: Bindings }>();
app.use("*", async (c, next) => {
  c.set("auth", { ...TEST_AUTH, scope: "personal_corp" });
  await next();
});
app.route("/batch-import", batchImportRoute);
app.route("/archive", archiveRoute);
app.route("/documents", documentsRoute);
app.route("/extraction-writeback", extractionWritebackRoute);
app.route("/recurring", recurringRoute);
app.route("/uploads", uploadsRoute);

const INBOX = "Paraacco_公司財務系統/00_收件/20260928";

function randomSha() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function post(path: string, body: unknown) {
  return app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
}

async function ingest(overrides: Record<string, unknown> = {}) {
  const sha256 = randomSha();
  const res = await post("/batch-import/documents-local", {
    fileName: "掃描 2026,09,28.pdf",
    byteSize: 1234,
    mimeType: "application/pdf",
    sha256,
    localPath: `${INBOX}/{id}.pdf`,
    ...overrides,
  });
  const body = (await res.json()) as { id: string; localPath: string };
  return { res, sha256, ...body };
}

beforeAll(async () => {
  await createDb(env.DB)
    .insert(members)
    .values({ id: TEST_AUTH.memberId!, email: TEST_AUTH.email!, name: TEST_AUTH.name!, role: "accountant", scope: "personal_corp" });
});

describe("每日進件 documents-local", () => {
  it("只登記 NAS 路徑:storage=local、{id} 換成 DOC id、R2 沒有新物件", async () => {
    const before = await env.FILES.list();
    const { res, id, localPath, sha256 } = await ingest();
    expect(res.status).toBe(201);
    expect(localPath).toBe(`${INBOX}/${id}.pdf`);

    const [file] = await createDb(env.DB).select().from(documentFiles).where(eq(documentFiles.documentId, id));
    expect(file.storage).toBe("local");
    expect(file.localPath).toBe(localPath);
    expect(file.sha256).toBe(sha256);
    expect(file.r2Key).toBe(`local:${id}/original`);
    expect((await env.FILES.list()).objects.length).toBe(before.objects.length);
  });

  it("路徑不在受管區、含 ..、絕對路徑、sha256 格式錯都 400", async () => {
    for (const localPath of ["00_收件/a.pdf", `${INBOX}/../x.pdf`, "/Volumes/ATLPAR_Bookkeeper/x.pdf", "smb://x/y.pdf"]) {
      expect((await ingest({ localPath })).res.status).toBe(400);
    }
    expect((await ingest({ sha256: "ABC" })).res.status).toBe(400);
  });

  it("舊的 multipart 上傳、網頁預簽上傳都回 410", async () => {
    const form = new FormData();
    form.set("file", new File(["x"], "a.pdf", { type: "application/pdf" }));
    expect((await app.request("/batch-import/documents", { method: "POST", body: form }, env)).status).toBe(410);
    expect((await post("/uploads/presign", { fileName: "a.pdf" })).status).toBe(410);
  });

  it("GET /documents/:id/file:local 文件回 NAS 位置 JSON,不串流檔案", async () => {
    const { id, localPath } = await ingest();
    const res = await app.request(`/documents/${id}/file`, {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ storage: "local", localRoot: "smb://192.168.20.91/ATLPAR_Bookkeeper", localPath });
  });

  it("擷取寫回:備註開頭的 [TAG] 存成 finance_doc_type", async () => {
    const { id } = await ingest();
    const res = await post(`/extraction-writeback/documents/${id}`, { confidence: "high", source: "test", notes: "[UTIL] 水費繳費憑證", vendorNameRaw: "臺北自來水事業處" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { written: string[] }).written).toContain("finance_doc_type");
  });

  it("信用卡帳單/銀行對帳單寫回自動帶 ownership_scope=shared,列表帶出 ownershipScope", async () => {
    const { id } = await ingest();
    const res = await post(`/extraction-writeback/documents/${id}`, { confidence: "high", source: "test", notes: "[CCS] 玉山信用卡帳單" });
    expect(((await res.json()) as { written: string[] }).written).toContain("ownership_scope");
    const list = (await (await app.request("/documents", {}, env)).json()) as { documents: { id: string; ownershipScope: string | null }[] };
    expect(list.documents.find((d) => d.id === id)?.ownershipScope).toBe("shared");
    const arch = (await (await app.request(`/archive/documents?ids=${id}`, {}, env)).json()) as { documents: { financeDocType: string | null }[] };
    expect(arch.documents[0].financeDocType).toBe("CCS");
  });

  it("normalized-file:local 文件回 409,不寫 R2", async () => {
    const { id } = await ingest();
    const res = await app.request(
      `/extraction-writeback/documents/${id}/normalized-file`,
      { method: "POST", headers: { "Content-Type": "application/pdf" }, body: "%PDF-1.4 test" },
      env,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("local_storage");
  });
});

describe("歸檔回寫 /archive", () => {
  const FILED = "Paraacco_公司財務系統/10_平行空間有限公司/2026/01_發票收據";

  it("fromPath 與 sha256 相符才更新;寫 filed_at 與 activity_log;重送冪等", async () => {
    const { id, localPath, sha256 } = await ingest();
    const toPath = `${FILED}/20260928_發票_測試_100_${id}.pdf`;

    expect((await post(`/archive/documents/${id}/move`, { fromPath: `${INBOX}/other.pdf`, toPath, sha256 })).status).toBe(409);
    expect((await post(`/archive/documents/${id}/move`, { fromPath: localPath, toPath, sha256: randomSha() })).status).toBe(409);

    const ok = await post(`/archive/documents/${id}/move`, { fromPath: localPath, toPath, sha256 });
    expect(ok.status).toBe(200);
    const db = createDb(env.DB);
    const [file] = await db.select().from(documentFiles).where(eq(documentFiles.documentId, id));
    expect(file.localPath).toBe(toPath);
    const [doc] = await db.select().from(documents).where(eq(documents.id, id));
    expect(doc.filedAt).not.toBeNull();
    const logs = await db.select().from(activityLog).where(eq(activityLog.entityId, id));
    expect(logs.some((l) => l.kind === "archive")).toBe(true);

    const again = await post(`/archive/documents/${id}/move`, { fromPath: localPath, toPath, sha256 });
    expect(await again.json()).toMatchObject({ ok: true, unchanged: true });

    // 回滾:搬回 00_收件,filed_at 清空
    await post(`/archive/documents/${id}/move`, { fromPath: toPath, toPath: localPath, sha256 });
    const [rolledBack] = await db.select().from(documents).where(eq(documents.id, id));
    expect(rolledBack.filedAt).toBeNull();
  });

  it("批次:任何一筆不合就整批不寫;全部合格才一次寫入;上限 50 筆", async () => {
    const a = await ingest();
    const b = await ingest();
    const moveA = { documentId: a.id, fromPath: a.localPath, toPath: `${FILED}/A_${a.id}.pdf`, sha256: a.sha256 };
    const badB = { documentId: b.id, fromPath: `${INBOX}/wrong.pdf`, toPath: `${FILED}/B_${b.id}.pdf`, sha256: b.sha256 };

    const rejected = await post("/archive/moves", { moves: [moveA, badB] });
    expect(rejected.status).toBe(409);
    const db = createDb(env.DB);
    const [fa] = await db.select().from(documentFiles).where(eq(documentFiles.documentId, a.id));
    expect(fa.localPath).toBe(a.localPath);

    const okRes = await post("/archive/moves", { moves: [moveA, { ...badB, fromPath: b.localPath }] });
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toMatchObject({ ok: true, written: 2 });

    const tooMany = Array.from({ length: 51 }, () => moveA);
    expect((await post("/archive/moves", { moves: tooMany })).status).toBe(400);
  });

  it("GET /archive/documents:ids 查詢與分頁,只列 storage=local", async () => {
    const a = await ingest();
    const byIds = (await (await app.request(`/archive/documents?ids=${a.id},DOC-TEST-R2`, {}, env)).json()) as { documents: { documentId: string; localPath: string; sha256: string }[] };
    expect(byIds.documents).toEqual([expect.objectContaining({ documentId: a.id, localPath: a.localPath, sha256: a.sha256 })]);
    const page = (await (await app.request("/archive/documents?limit=1", {}, env)).json()) as { documents: unknown[]; next: string | null };
    expect(page.documents).toHaveLength(1);
    expect(page.next).not.toBeNull();
  });

  it("移出系統:目的地可以是 _系統外資料/,但進件登記不行", async () => {
    const a = await ingest();
    const toPath = `_系統外資料/證券對帳單/${a.localPath}`;
    expect((await post(`/archive/documents/${a.id}/move`, { fromPath: a.localPath, toPath, sha256: a.sha256 })).status).toBe(200);
    expect((await ingest({ localPath: "_系統外資料/x/{id}.pdf" })).res.status).toBe(400);
    expect((await post(`/archive/documents/${a.id}/move`, { fromPath: toPath, toPath: "其他/x/y.pdf", sha256: a.sha256 })).status).toBe(400);
  });

  it("R2 文件不能用歸檔端點", async () => {
    const db = createDb(env.DB);
    await db.insert(documents).values({ id: "DOC-TEST-R2", ownership: "corp", source: "api_import" });
    await db.insert(documentFiles).values({
      documentId: "DOC-TEST-R2",
      kind: "original",
      r2Key: "documents/test/r2.pdf",
      originalFileName: "r2.pdf",
      mimeType: "application/pdf",
      byteSize: 1,
      sha256: "a".repeat(64),
    });
    const res = await post("/archive/documents/DOC-TEST-R2/move", {
      fromPath: `${INBOX}/x.pdf`,
      toPath: `${FILED}/x.pdf`,
      sha256: "a".repeat(64),
    });
    expect(((await res.json()) as { error: string }).error).toBe("not_local");
  });
});

describe("定期帳單 /recurring", () => {
  it("覆核確認帳單月份/series/專案代碼 → coverage 反映有/只有催繳/人工標記/缺", async () => {
    const db = createDb(env.DB);
    await db.insert(recurringSeries).values({
      id: "RCS-T01",
      name: "測試健保(月)",
      ownership: "corp",
      cadence: "monthly",
      startMonth: "2026-01",
      endMonth: "2026-04",
      matchRule: JSON.stringify({ vendorNameKeywords: ["健保"] }),
    });

    const bill = await ingest();
    const reminder = await ingest();
    const confirm = await post(`/recurring/documents/${bill.id}`, {
      billingMonths: ["2026-02", "2026-01"],
      recurringSeriesId: "RCS-T01",
      projectCode: "ap_26001",
    });
    expect(confirm.status).toBe(200);
    expect((await post(`/recurring/documents/${reminder.id}`, { billingMonths: ["2026-03"], recurringSeriesId: "RCS-T01" })).status).toBe(200);
    await db.insert(documentCaseLinks).values({ caseId: reminder.id, documentId: reminder.id, role: "reminder", linkedBy: "manual" });
    expect((await post("/recurring/series/RCS-T01/marks", { month: "2026-04", status: "not_required", note: "停保" })).status).toBe(200);

    const detail = (await (await app.request(`/recurring/documents/${bill.id}`, {}, env)).json()) as Record<string, unknown>;
    expect(detail).toMatchObject({ billingMonths: ["2026-01", "2026-02"], recurringSeriesId: "RCS-T01", projectCode: "AP_26001", billingMonthsConfirmed: true });

    const res = await app.request("/recurring/coverage?from=2025-12&to=2026-05", {}, env);
    expect(res.status).toBe(200);
    const { series } = (await res.json()) as { series: { id: string; months: { month: string; status: string; documentIds: string[] }[]; summary: Record<string, number> }[] };
    const s = series.find((x) => x.id === "RCS-T01")!;
    expect(s.months.map((m) => [m.month, m.status])).toEqual([
      ["2026-01", "present"],
      ["2026-02", "present"],
      ["2026-03", "reminder_only"],
      ["2026-04", "not_required"],
    ]);
    expect(s.months[0].documentIds).toEqual([bill.id]);
    expect(s.summary).toMatchObject({ expected: 4, present: 2, reminderOnly: 1, notRequired: 1, missing: 0 });

    // 取消標記 → 缺
    await post("/recurring/series/RCS-T01/marks", { month: "2026-04", status: null });
    const again = (await (await app.request("/recurring/coverage?from=2026-04&to=2026-04", {}, env)).json()) as typeof res extends never ? never : { series: { id: string; summary: Record<string, number> }[] };
    expect(again.series.find((x) => x.id === "RCS-T01")!.summary.missing).toBe(1);
  });

  it("參數驗證", async () => {
    expect((await app.request("/recurring/coverage?from=2026-13&to=2026-01", {}, env)).status).toBe(400);
    const { id } = await ingest();
    expect((await post(`/recurring/documents/${id}`, { billingMonths: ["2026/01"] })).status).toBe(400);
    expect((await post(`/recurring/documents/${id}`, { projectCode: "X123" })).status).toBe(400);
    expect((await post(`/recurring/documents/${id}`, { recurringSeriesId: "RCS-NOPE" })).status).toBe(400);
  });
});
