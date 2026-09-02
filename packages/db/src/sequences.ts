// 人類可讀 ID 流水號的交易安全遞增 —— 用 SQLite 的 INSERT ... ON CONFLICT DO UPDATE(upsert)
// 一次完成「讀取現有值 + 加 1 + 寫回」,避免兩個請求同時搶號拿到重複 ID。

import { sql } from "drizzle-orm";
import { formatSequentialId, type IdEntity } from "@paraacco/domain";
import type { Db } from "./client";
import { idSequences } from "./schema";

export async function nextId(db: Db, entity: IdEntity, year: number): Promise<string> {
  const rows = await db
    .insert(idSequences)
    .values({ entity, year, lastSeq: 1 })
    .onConflictDoUpdate({
      target: [idSequences.entity, idSequences.year],
      set: { lastSeq: sql`${idSequences.lastSeq} + 1` },
    })
    .returning({ lastSeq: idSequences.lastSeq });

  const seq = rows[0]?.lastSeq ?? 1;
  return formatSequentialId(entity, year, seq);
}
