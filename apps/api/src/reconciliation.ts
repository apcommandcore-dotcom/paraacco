// 憑證 × 對帳單勾稽的共用邏輯——routes/internal/statement-lines.ts(document-worker 落地新
// 明細列時呼叫)、scheduled.ts(每日排程重新比對)都會用到,抽出來避免兩邊各寫一份。

import { eq, ne } from "drizzle-orm";
import { purchases, statementLines, type Db } from "@paraacco/db";
import { matchStatementLine } from "@paraacco/domain";

type PurchaseCandidate = { id: string; amountCents: number; purchaseDate: string; vendorNameRaw: string };

export async function candidatesForEntity(db: Db, entityId: string): Promise<PurchaseCandidate[]> {
  return db
    .select({ id: purchases.id, amountCents: purchases.amountCents, purchaseDate: purchases.purchaseDate, vendorNameRaw: purchases.vendorNameRaw })
    .from(purchases)
    .where(eq(purchases.entityId, entityId));
}

/**
 * 重新比對所有還沒 matched 的 statement_lines——candidate purchases 可能是後來才建立/編輯
 * 的(例如人工在 Review 畫面把某筆文件連結/建立成採購案之後),需要有個地方讓已經落地的
 * 明細列重新有機會比對成功,不能只在明細列剛寫入的當下比對一次就定案。
 */
export async function reconcilePendingStatementLines(db: Db): Promise<{ checked: number; updated: number }> {
  const pending = await db.select().from(statementLines).where(ne(statementLines.reconciliationStatus, "matched"));

  const candidatesByEntity = new Map<string, PurchaseCandidate[]>();
  let updated = 0;

  for (const line of pending) {
    let candidates = candidatesByEntity.get(line.entityId);
    if (!candidates) {
      candidates = await candidatesForEntity(db, line.entityId);
      candidatesByEntity.set(line.entityId, candidates);
    }

    const result = matchStatementLine({ amountCents: line.amountCents, date: line.date }, line.description, candidates);
    if (
      result.status === line.reconciliationStatus &&
      result.purchaseId === line.matchedPurchaseId &&
      result.confidence === line.matchConfidence
    ) {
      continue; // 結果沒變,不用寫入,省一次 D1 write。
    }

    await db
      .update(statementLines)
      .set({
        reconciliationStatus: result.status,
        matchedPurchaseId: result.purchaseId,
        matchConfidence: result.confidence,
        matchNote: result.note,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(statementLines.id, line.id));
    updated += 1;
  }

  return { checked: pending.length, updated };
}
