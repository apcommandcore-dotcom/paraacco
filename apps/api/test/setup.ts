// 測試環境初始化 —— 在每個測試檔案的 Miniflare worker 環境裡跑一次,把 D1 schema 灌進去。
// 完全在本機 Miniflare 裡跑,不會連到正式環境的 D1(wrangler.toml 裡的 database_id 只是拿來
// 讓 @cloudflare/vitest-plugin 知道要建立一個叫這個名字的本機 D1 binding,不代表真的連過去)。

import { applyD1Migrations, env } from "cloudflare:test";

// packages/db/migrations 底下 drizzle-kit 產生的 migration(見 vitest.config.ts 的
// readD1Migrations),透過 miniflare bindings 傳進來。
declare module "cloudflare:test" {
  interface ProvidedEnv {
    TEST_MIGRATIONS: Awaited<ReturnType<typeof import("@cloudflare/vitest-plugin").readD1Migrations>>;
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// document_fts 這張表是手寫 SQL(packages/db/migrations-manual/0001_document_fts.sql),
// 不在 drizzle 的 migration journal 裡,跟正式環境部署時一樣要另外手動套用一次。
await env.DB.exec(
  `CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(document_id UNINDEXED, vendor_name, invoice_no, order_no, serial_no, brand, model, extracted_text, file_names, tokenize = 'unicode61 remove_diacritics 2')`,
);
