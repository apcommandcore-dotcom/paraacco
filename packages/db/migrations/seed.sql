-- 開發用種子資料 —— 非 drizzle-kit 產生的 migration,不會被 `wrangler d1 migrations apply` 自動套用。
-- 用法:wrangler d1 execute paraacco-db --remote --file=./migrations/seed.sql
--
-- members 資料對應 apps/api/src/whoami.ts 裡的 TEAM 表(Cloudflare Access 驗證通過的 email)。
-- role/scope 是初始猜測值,請依實際情況在管理後台或直接改 D1 調整
-- (scope: 'personal_corp' | 'corp' | 'corp_readonly',見規格文件 2.12)。

INSERT INTO members (id, email, name, role, scope, status) VALUES
  ('MEM-000001', 'theosyl@icloud.com', 'ShaoYi', 'admin', 'personal_corp', 'active'),
  ('MEM-000002', 'wu.plhojita@gmail.com', 'PeiLing', 'finance', 'corp', 'active');

-- 分類樹範例(對應規格文件 2.7),之後由管理後台維護,這裡只是讓系統一開始不是空的。
INSERT INTO categories (id, ownership_scope, parent_id, name) VALUES
  ('CAT-CORP-001', 'corp', NULL, '電腦與周邊'),
  ('CAT-CORP-002', 'corp', NULL, '軟體訂閱'),
  ('CAT-CORP-003', 'corp', NULL, '水電瓦斯'),
  ('CAT-PER-001', 'per', NULL, '自行車零件升級'),
  ('CAT-PER-002', 'per', NULL, '生活雜支');
