// 側邊欄數量徽章 —— 2026-09-07 補完設計落差任務書任務 1。收件匣/待覆核頁面本身載入時
// 是抓整包 GET /api/documents?status= 在前端算數量(見 app/inbox/page.tsx、
// app/review/page.tsx),沒有共用的輕量計數,所以側邊欄另外開這支端點,只回傳兩個數字,
// 不用像上面那樣抓整包文件列表。inbox 數量是「還在收件匣、尚未進入待覆核/歸檔」的文件,
// 對照 documents.status 的 pipeline 前段狀態(queued 到 vendor_check 之間都算);
// pendingReview 就是 status='review'。

import { Hono } from "hono";
import { inArray, sql } from "drizzle-orm";
import { createDb, documents } from "@paraacco/db";
import type { Bindings } from "../bindings";

export const countsRoute = new Hono<{ Bindings: Bindings }>();

const INBOX_STAGE_STATUSES = ["queued", "validating", "ocr", "extract", "classifying", "matching", "vendor_check", "retry"];

countsRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const [inboxRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(documents)
    .where(inArray(documents.status, INBOX_STAGE_STATUSES));
  const [reviewRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(documents)
    .where(sql`${documents.status} = 'review'`);

  return c.json({ inbox: inboxRow?.n ?? 0, pendingReview: reviewRow?.n ?? 0 });
});
