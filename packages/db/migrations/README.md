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

開發用種子資料(members / categories 範例)不算 migration,要另外執行:

```bash
npx wrangler d1 execute paraacco-db --remote --file=./migrations/seed.sql
```

也可以直接把 `migrations/0000_*.sql` 的內容貼到 Cloudflare Dashboard → D1 → paraacco-db → Console
執行,效果相同,不需要本機裝 wrangler。
