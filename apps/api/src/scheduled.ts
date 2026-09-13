// 排程通知 —— 2026-09-07 補完設計落差任務書任務 5。三個 Cloudflare Cron Trigger(見
// wrangler.toml 的 [triggers] crons)共用這裡的邏輯,每個函式都是純函式(db + now 兩個
// 參數),方便 vitest 直接呼叫驗證,不用真的等 cron 觸發——見 test/scheduled.test.ts。
//
// 時間點判斷(Theo 沒有指定精確時間,這裡是我依合理判斷定的,見
// CODE_REPORT_complete-design-gaps_20260907.md 任務 5 段落的說明):
//   - 小覆核提醒:每週五 09:00(Asia/Taipei,UTC+8)= 01:00 UTC,呼應任務 4「週一前清完當週」
//     的邏輯,週五提醒還來得及在週一前處理完。
//   - 總覆核提醒:每月 1 號 09:00 Taipei = 01:00 UTC,內容是「上個月」的總結(月初才有完整
//     的上月資料可以算,不用處理「月底最後一天」在 cron 標準語法裡不好表示的問題)。
//   - 收件匣逾期 / 保固到期兩個事件觸發通知本質上是「時間條件」不是「單一離散事件」,沒辦法
//     掛在某個 API 呼叫點上觸發,所以也用排程掃描,選在每天 00:00 UTC(08:00 Taipei)跑一次。
//   - 對帳單勾稽重新比對(2026-09-13 財務文件自動分類新增)併在同一個每日排程——candidate
//     purchases 可能是明細列落地之後才建立/編輯的,需要定期重跑才有機會從 suggested/
//     unmatched 變成 matched,見 reconciliation.ts。

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { computeWarrantyStatus, daysUntilEndOfWeek } from "@paraacco/domain";
import { documents, warrantySubscriptions, type Db } from "@paraacco/db";
import { createNotification } from "./notify";
import { reconcilePendingStatementLines } from "./reconciliation";

const INBOX_STAGE_STATUSES = ["queued", "validating", "ocr", "extract", "classifying", "matching", "vendor_check", "retry"];
const STALE_INBOX_DAYS = 3;

export async function runWeeklyReview(db: Db, now: Date = new Date()): Promise<void> {
  const [reviewCountRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(documents)
    .where(eq(documents.status, "review"));
  const pendingCount = reviewCountRow?.n ?? 0;
  const daysLeft = daysUntilEndOfWeek(now);

  await createNotification(db, {
    type: "weekly_review",
    title: "本週小覆核提醒",
    message:
      pendingCount > 0
        ? `目前還有 ${pendingCount} 份文件待覆核,距離本週日還有 ${Math.max(daysLeft, 0)} 天,記得在週一前清空。`
        : "待覆核清單目前是空的,本週不用特別處理。",
    severity: pendingCount > 0 ? "warning" : "info",
  });
}

export async function runMonthlyReview(db: Db, now: Date = new Date()): Promise<void> {
  // 「上個月」= now 所在月份的前一個月(見檔頭說明,月初跑排程時上個月資料才完整)。
  const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const firstOfLastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  const [archivedRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(documents)
    .where(and(eq(documents.status, "archived"), sql`${documents.archivedAt} >= ${firstOfLastMonth.toISOString()}`, sql`${documents.archivedAt} < ${firstOfThisMonth.toISOString()}`));
  const [pendingRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(documents)
    .where(eq(documents.status, "review"));
  const [totalLastMonthRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(documents)
    .where(and(sql`${documents.createdAt} >= ${firstOfLastMonth.toISOString()}`, sql`${documents.createdAt} < ${firstOfThisMonth.toISOString()}`));

  const archived = archivedRow?.n ?? 0;
  const total = totalLastMonthRow?.n ?? 0;
  // 完整度定義(設計稿沒有寫清楚精確公式,這裡用「上月新進文件中已歸檔的比例」這個合理定義,
  // 見任務書任務 1 對「本月摘要」widget 用同一個定義)。
  const completenessPct = total > 0 ? Math.round((archived / total) * 100) : 100;

  await createNotification(db, {
    type: "monthly_review",
    title: "本月總覆核提醒",
    message: `上個月憑證完整度約 ${completenessPct}%(${archived}/${total} 份已歸檔),目前還有 ${pendingRow?.n ?? 0} 份待覆核。`,
    severity: completenessPct < 80 ? "warning" : "info",
  });
}

export async function runStaleInboxSweep(db: Db, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - STALE_INBOX_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const staleRows = await db
    .select({ id: documents.id, vendorNameRaw: documents.vendorNameRaw, createdAt: documents.createdAt })
    .from(documents)
    .where(and(inArray(documents.status, INBOX_STAGE_STATUSES), lt(documents.createdAt, cutoff)));

  for (const row of staleRows) {
    await createNotification(db, {
      type: "inbox_stale",
      title: "收件匣文件逾期未處理",
      message: `${row.vendorNameRaw ?? row.id} 已經超過 ${STALE_INBOX_DAYS} 天還在收件匣階段,建議確認是不是卡住了。`,
      entityType: "document",
      entityId: row.id,
      severity: "warning",
    });
  }
}

export async function runWarrantyDueSweep(db: Db, now: Date = new Date()): Promise<void> {
  const rows = await db.select().from(warrantySubscriptions);
  for (const row of rows) {
    const status = computeWarrantyStatus({ endDate: row.endDate, reminderDaysBefore: row.reminderDaysBefore }, now);
    if (status !== "due_soon") continue;
    await createNotification(db, {
      type: "warranty_due",
      title: "保固/訂閱即將到期",
      message: `${row.name} 將在 ${row.endDate} 到期。`,
      entityType: "warranty_subscription",
      entityId: row.id,
      severity: "warning",
    });
  }
}

/** 每天一次的掃描(收件匣逾期 + 保固到期 + 對帳單重新勾稽),見檔頭說明為什麼前兩者是排程
 * 掃描不是事件觸發。重新勾稽併在同一個每日排程裡,不另外開一條 cron——candidate purchases
 * 可能是明細列落地之後才建立/編輯的,需要定期重跑,跟收件匣/保固到期一樣是「時間條件」
 * 而非單一離散事件,共用同一個排程時機沒有語意上的問題(見
 * apps/api/src/reconciliation.ts)。 */
export async function runDailySweep(db: Db, now: Date = new Date()): Promise<void> {
  await runStaleInboxSweep(db, now);
  await runWarrantyDueSweep(db, now);
  await reconcilePendingStatementLines(db);
}

// Cloudflare Cron Trigger 的 event.cron 字串跟 wrangler.toml 設定的完全一致才能比對,
// 見 wrangler.toml 的 crons 陣列跟這裡的字串必須手動保持同步。
export async function handleScheduled(cron: string, db: Db, now: Date = new Date()): Promise<void> {
  if (cron === "0 1 * * 5") {
    await runWeeklyReview(db, now);
  } else if (cron === "0 1 1 * *") {
    await runMonthlyReview(db, now);
  } else if (cron === "0 0 * * *") {
    await runDailySweep(db, now);
  }
}
