// 同一案件關聯文件(document_case_links)—— 規格見 packages/db/src/schema.ts 的
// documentCaseLinks 表定義註解、paraacco-document-case-links-design-evaluation-20260916.md。
// case_id 借用該案件「第一份文件」的 document.id 本身,不另建 cases 主檔表——建立新案件時,
// 前端直接把 caseId 設成錨點文件自己的 id 即可,不需要另一個「建立案件」端點。

import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import { createDb, documentCaseLinks, documents } from "@paraacco/db";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";

export const caseLinksRoute = new Hono<{ Bindings: Bindings }>();

// 查一份文件屬於哪個(些)案件,回傳該案件底下全部文件(含這份自己)+ 各自的 role,讓文件
// 詳情頁/依標題瀏覽的供應商詳情頁可以顯示「相關文件」區塊。一份文件理論上可能同時屬於多個
// 案件(目前 UI 還沒有這種情境,但 schema 允許),所以是先查 caseId 集合、再撈全部列。
caseLinksRoute.get("/documents/:documentId", async (c) => {
  const documentId = c.req.param("documentId");
  const db = createDb(c.env.DB);

  const ownLinks = await db.select().from(documentCaseLinks).where(eq(documentCaseLinks.documentId, documentId));
  if (ownLinks.length === 0) return c.json({ cases: [] });

  const caseIds = [...new Set(ownLinks.map((l) => l.caseId))];
  const allLinks = await db
    .select({
      caseId: documentCaseLinks.caseId,
      documentId: documentCaseLinks.documentId,
      role: documentCaseLinks.role,
      linkedBy: documentCaseLinks.linkedBy,
      docTypeCode: documents.docTypeCode,
      vendorNameRaw: documents.vendorNameRaw,
      docDate: documents.docDate,
      status: documents.status,
    })
    .from(documentCaseLinks)
    .innerJoin(documents, eq(documents.id, documentCaseLinks.documentId))
    .where(inArray(documentCaseLinks.caseId, caseIds));

  const cases = caseIds.map((caseId) => ({
    caseId,
    documents: allLinks.filter((l) => l.caseId === caseId).sort((a, b) => (a.docDate ?? "").localeCompare(b.docDate ?? "")),
  }));

  return c.json({ cases });
});

// 把一份文件加進一個案件——caseId 是案件錨點文件的 id(新案件就直接傳錨點文件自己的 id,
// 這支端點對「建立新案件」跟「把文件加進既有案件」一視同仁,不用分兩支端點)。
caseLinksRoute.post("/", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{ caseId: string; documentId: string; role: string }>();
  const db = createDb(c.env.DB);

  await db
    .insert(documentCaseLinks)
    .values({ caseId: body.caseId, documentId: body.documentId, role: body.role, linkedBy: "manual", createdByMemberId: auth.memberId })
    .onConflictDoUpdate({ target: [documentCaseLinks.caseId, documentCaseLinks.documentId], set: { role: body.role } });

  return c.json({ ok: true });
});
