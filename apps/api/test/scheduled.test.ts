// 補完設計落差任務書任務 5(通知中心)的排程邏輯測試——真的呼叫 src/scheduled.ts 的每個
// 函式,對本機 Miniflare D1 驗證寫入結果,不是只讀程式碼判斷「應該會動」。Cloudflare Cron
// Trigger 本身沒辦法在本機觸發,這點在報告裡誠實記錄,這裡測的是排程「邏輯」本身。

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, documents, notifications, warrantySubscriptions } from "@paraacco/db";
import { eq } from "drizzle-orm";
import { runDailySweep, runMonthlyReview, runStaleInboxSweep, runWarrantyDueSweep, runWeeklyReview, handleScheduled } from "../src/scheduled";
import { createNotification } from "../src/notify";

describe("排程通知邏輯", () => {
  beforeEach(async () => {
    const db = createDb(env.DB);
    await db.delete(notifications);
    await db.delete(warrantySubscriptions);
    await db.delete(documents);
  });

  it("runWeeklyReview:有待覆核文件時,寫入 weekly_review 通知且訊息含正確筆數", async () => {
    const db = createDb(env.DB);
    await db.insert(documents).values([
      { id: "DOC-TEST-000001", ownership: "corp", source: "api_import", status: "review" },
      { id: "DOC-TEST-000002", ownership: "corp", source: "api_import", status: "review" },
      { id: "DOC-TEST-000003", ownership: "corp", source: "api_import", status: "archived" },
    ]);

    await runWeeklyReview(db, new Date("2026-09-10T02:00:00Z")); // 週四,測 daysUntilEndOfWeek 算得出來就好

    const rows = await db.select().from(notifications).where(eq(notifications.type, "weekly_review"));
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain("2 份文件待覆核");
    expect(rows[0].severity).toBe("warning");
  });

  it("runWeeklyReview:沒有待覆核文件時,訊息是清空狀態、severity 是 info", async () => {
    const db = createDb(env.DB);
    await runWeeklyReview(db, new Date("2026-09-10T02:00:00Z"));
    const rows = await db.select().from(notifications).where(eq(notifications.type, "weekly_review"));
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("info");
  });

  it("runMonthlyReview:完整度 = 上月已歸檔 / 上月新進文件,訊息含算出來的百分比", async () => {
    const db = createDb(env.DB);
    // now = 2026-09-01,上個月 = 2026-08。4 筆上月新進,3 筆已歸檔(archivedAt 也在上月內)→ 75%。
    await db.insert(documents).values([
      { id: "DOC-TEST-000010", ownership: "corp", source: "api_import", status: "archived", createdAt: "2026-08-05T00:00:00Z", archivedAt: "2026-08-06T00:00:00Z" },
      { id: "DOC-TEST-000011", ownership: "corp", source: "api_import", status: "archived", createdAt: "2026-08-10T00:00:00Z", archivedAt: "2026-08-11T00:00:00Z" },
      { id: "DOC-TEST-000012", ownership: "corp", source: "api_import", status: "archived", createdAt: "2026-08-15T00:00:00Z", archivedAt: "2026-08-16T00:00:00Z" },
      { id: "DOC-TEST-000013", ownership: "corp", source: "api_import", status: "review", createdAt: "2026-08-20T00:00:00Z" },
      // 上上個月的文件不該被算進「上個月」的分母。
      { id: "DOC-TEST-000014", ownership: "corp", source: "api_import", status: "archived", createdAt: "2026-07-01T00:00:00Z", archivedAt: "2026-07-02T00:00:00Z" },
    ]);

    await runMonthlyReview(db, new Date("2026-09-01T01:00:00Z"));

    const rows = await db.select().from(notifications).where(eq(notifications.type, "monthly_review"));
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain("75%");
    expect(rows[0].message).toContain("3/4");
  });

  it("runStaleInboxSweep:收件匣階段超過 3 天的文件才會通知,且同一份文件不會重複通知(dedupe)", async () => {
    const db = createDb(env.DB);
    const now = new Date("2026-09-10T00:00:00Z");
    await db.insert(documents).values([
      // 5 天前建立、還在 queued 階段 → 該通知。
      { id: "DOC-TEST-000020", ownership: "corp", source: "api_import", status: "queued", createdAt: "2026-09-05T00:00:00Z" },
      // 1 天前建立 → 還沒超過 3 天,不該通知。
      { id: "DOC-TEST-000021", ownership: "corp", source: "api_import", status: "queued", createdAt: "2026-09-09T00:00:00Z" },
      // 5 天前建立但已經 archived → 不在收件匣階段,不該通知。
      { id: "DOC-TEST-000022", ownership: "corp", source: "api_import", status: "archived", createdAt: "2026-09-05T00:00:00Z" },
    ]);

    await runStaleInboxSweep(db, now);
    let rows = await db.select().from(notifications).where(eq(notifications.type, "inbox_stale"));
    expect(rows).toHaveLength(1);
    expect(rows[0].entityId).toBe("DOC-TEST-000020");

    // 隔天再跑一次同一個 sweep,同一份文件不該被重複通知。
    await runStaleInboxSweep(db, new Date("2026-09-11T00:00:00Z"));
    rows = await db.select().from(notifications).where(eq(notifications.type, "inbox_stale"));
    expect(rows).toHaveLength(1);
  });

  it("runWarrantyDueSweep:只有落在 reminderDaysBefore 窗口內、還沒過期的項目才通知", async () => {
    const db = createDb(env.DB);
    const now = new Date("2026-09-10T00:00:00Z");
    await db.insert(warrantySubscriptions).values([
      // 20 天後到期,提醒窗口 30 天 → 該通知。
      { id: "WSU-TEST-000001", ownership: "corp", name: "即將到期項目", type: "warranty", endDate: "2026-09-30", reminderDaysBefore: 30 },
      // 200 天後到期 → 還不用通知。
      { id: "WSU-TEST-000002", ownership: "corp", name: "很久之後到期", type: "subscription", endDate: "2027-03-30", reminderDaysBefore: 30 },
      // 已過期(狀態是 expired,不是 due_soon)→ 這支 sweep 目前只處理 due_soon,不通知。
      { id: "WSU-TEST-000003", ownership: "corp", name: "已過期項目", type: "warranty", endDate: "2026-01-01", reminderDaysBefore: 30 },
    ]);

    await runWarrantyDueSweep(db, now);
    const rows = await db.select().from(notifications).where(eq(notifications.type, "warranty_due"));
    expect(rows).toHaveLength(1);
    expect(rows[0].entityId).toBe("WSU-TEST-000001");
  });

  it("runDailySweep 同時涵蓋收件匣逾期跟保固到期兩種事件", async () => {
    const db = createDb(env.DB);
    const now = new Date("2026-09-10T00:00:00Z");
    await db.insert(documents).values([{ id: "DOC-TEST-000030", ownership: "corp", source: "api_import", status: "queued", createdAt: "2026-09-01T00:00:00Z" }]);
    await db.insert(warrantySubscriptions).values([{ id: "WSU-TEST-000010", ownership: "corp", name: "測試項目", type: "warranty", endDate: "2026-09-15", reminderDaysBefore: 30 }]);

    await runDailySweep(db, now);
    const rows = await db.select().from(notifications);
    expect(rows.map((r) => r.type).sort()).toEqual(["inbox_stale", "warranty_due"]);
  });

  it("createNotification 的 dedupe 只看 (type, entityType, entityId) 三元組,不同 type 不會互相擋", async () => {
    const db = createDb(env.DB);
    const first = await createNotification(db, { type: "pipeline_failed", title: "a", message: "a", entityType: "document", entityId: "DOC-X" });
    const second = await createNotification(db, { type: "pipeline_failed", title: "b", message: "b", entityType: "document", entityId: "DOC-X" });
    const third = await createNotification(db, { type: "dup_candidate", title: "c", message: "c", entityType: "document", entityId: "DOC-X" });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(third).toBe(true);
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(2);
  });

  it("handleScheduled:未知的 cron 字串不會拋錯、也不會寫入任何通知", async () => {
    const db = createDb(env.DB);
    await expect(handleScheduled("* * * * *", db, new Date())).resolves.not.toThrow();
    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(0);
  });

  it("handleScheduled:週五的 cron 字串會觸發 runWeeklyReview", async () => {
    const db = createDb(env.DB);
    await handleScheduled("0 1 * * 5", db, new Date("2026-09-10T02:00:00Z"));
    const rows = await db.select().from(notifications).where(eq(notifications.type, "weekly_review"));
    expect(rows).toHaveLength(1);
  });
});
