# packages/db/migrations

`drizzle-kit generate`(在 packages/db 執行 `pnpm generate`)依 `src/schema.ts` 自動產生這裡的 migration
SQL 檔,不要手動編輯已產生的檔案 —— 改 `schema.ts` 再重新產生。

## 套用到遠端 D1(paraacco-db)

這個 repo 目前的 CI(Cloudflare Workers Builds)只負責 `wrangler deploy` 部署程式碼,不會自動套用
D1 migration。migration 需要手動用已登入的 wrangler CLI 套用一次:

```bash
cd packages/db
npx wrangler login          # 第一次需要,瀏覽器登入 Cloudflare 帳號
npx wrangler d1 migrations apply paraacco-db --remote
```

也可以直接把 `migrations/0000_*.sql` 的內容貼到 Cloudflare Dashboard → D1 → paraacco-db → Console
執行,效果相同,不需要本機裝 wrangler。

## 手動 SQL(migrations-manual/,不算 drizzle migration)

`migrations-manual/` 底下是 drizzle-kit 無法產生的 SQL(目前是 `document_fts` FTS5 全文檢索虛擬表,
drizzle-kit 的 sqlite-core table builder 不支援 `CREATE VIRTUAL TABLE ... USING fts5`),跟開發用種子
資料 `seed.sql` 一樣不會被 `wrangler d1 migrations apply` 自動套用,要在套用完 `0000_*.sql` 之後手動
執行一次:

```bash
npx wrangler d1 execute paraacco-db --remote --file=./migrations-manual/0001_document_fts.sql
npx wrangler d1 execute paraacco-db --remote --file=./migrations/seed.sql
```

建議順序:`0000_*.sql`(建表)→ `migrations-manual/0001_document_fts.sql`(全文檢索表)→
`seed.sql`(members 初始資料)。
