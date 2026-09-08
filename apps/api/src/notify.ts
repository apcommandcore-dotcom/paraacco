// 通知寫入共用函式 —— 2026-09-07 補完設計落差任務書任務 5。事件觸發點(documents.ts、
// internal/documents.ts、transfers.ts)跟排程掃描(scheduled.ts)都呼叫這裡,不要各自
// insert,確保 dedupe 規則一致。
//
// dedupe 規則:同一個 (type, entityType, entityId) 三元組只要曾經產生過通知,就不再重複
// 產生——這個系統的通知都是「提醒去處理一件事」,不是「每次掃描都要看到」的即時動態,使用者
// 看過一次(或事件本身只會發生一次,例如 pipeline 失敗)就夠了,重複轟炸只會讓通知中心
// 變成雜訊。如果之後要做「同一份文件失敗兩次要各自提醒」這種語意,再另外處理,這裡先求
// 不要洗版。

import { and, eq } from "drizzle-orm";
import { notifications, type Db } from "@paraacco/db";

export type NotificationType =
  | "weekly_review"
  | "monthly_review"
  | "inbox_stale"
  | "warranty_due"
  | "dup_candidate"
  | "pipeline_failed"
  | "transfer_submitted"
  | "transfer_decided";

export interface NotificationInput {
  type: NotificationType;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
  severity?: "info" | "warning" | "critical";
}

/** 回傳是否真的寫入了新通知(dedupe 命中就回傳 false,呼叫端通常不用理會這個回傳值)。 */
export async function createNotification(db: Db, input: NotificationInput): Promise<boolean> {
  if (input.entityType && input.entityId) {
    const [existing] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.type, input.type), eq(notifications.entityType, input.entityType), eq(notifications.entityId, input.entityId)))
      .limit(1);
    if (existing) return false;
  }

  await db.insert(notifications).values({
    type: input.type,
    title: input.title,
    message: input.message,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    severity: input.severity ?? "info",
  });
  return true;
}
