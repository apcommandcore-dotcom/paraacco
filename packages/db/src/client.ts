// D1 client 工廠 —— apps/api 用 c.env.DB(wrangler.toml 的 [[d1_databases]] binding)呼叫這裡建立
// 型別安全的 query builder。document-worker 依設計邊界不可直接使用這個 client 寫入(見根目錄 README)。

import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof createDb>;
