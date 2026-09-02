-- 開發用種子資料 —— 非 drizzle-kit 產生的 migration,不會被 `wrangler d1 migrations apply` 自動套用。
-- 用法:wrangler d1 execute paraacco-db --remote --file=./migrations/seed.sql
--
-- 只放「真實」的初始資料(members 對應 apps/api/src/whoami.ts 裡的 TEAM 表,是實際會登入系統
-- 的人),不放設計稿(VaultLink v2.dc.html)裡的示範資料 —— 那些採購案/資產/文件/供應商/分類
-- 都只是 UI 設計參考用的假資料,不代表真實業務資料,故意不寫進種子檔。
--
-- role/scope 是初始猜測值,請依實際情況在管理後台或直接改 D1 調整
-- (scope: 'personal_corp' | 'corp' | 'corp_readonly',見規格文件 2.12)。

INSERT INTO members (id, email, name, role, scope, status) VALUES
  ('MEM-000001', 'theosyl@icloud.com', 'ShaoYi', 'admin', 'personal_corp', 'active'),
  ('MEM-000002', 'wu.plhojita@gmail.com', 'PeiLing', 'finance', 'corp', 'active');

-- 分類樹、供應商主檔、採購/資產/文件等業務資料一律留空,由實際使用時建立
-- (分類樹可在管理後台「分類樹與檔名模板」頁籤新增,見規格文件 2.7)。
