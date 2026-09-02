-- 開發用種子資料 —— 非 drizzle-kit 產生的 migration,不會被 `wrangler d1 migrations apply` 自動套用。
-- 用法:wrangler d1 execute paraacco-db --remote --file=./migrations/seed.sql
--
-- 只放「真實」的初始資料(members 對應實際會登入系統的人),不放設計稿(VaultLink v2.dc.html)
-- 裡的示範資料 —— 那些採購案/資產/文件/供應商/分類都只是 UI 設計參考用的假資料,不代表真實
-- 業務資料,故意不寫進種子檔。
--
-- role 對應範圍決策(2026-09-02 使用者確認):paraacco 介面的實際使用者只有「公司會計」與
-- 「負責人」兩種角色 + admin,見 packages/db/src/schema.ts 開頭註解。這裡 PeiLing 對應
-- 「會計」(role='accountant');ShaoYi 是實際操作/設定這個系統的人,先給 admin(不影響
-- 業務邏輯——歸屬移轉核准等判斷是看 scope='personal_corp' 不是看 role,見
-- apps/api/src/routes/transfers.ts),如果 ShaoYi 實際上就是「負責人」本人,之後可以在
-- 管理後台或直接改 D1 把 role 調整成 'principal'。
-- scope 三態見規格文件 2.12:'personal_corp' | 'corp' | 'corp_readonly'。

INSERT INTO members (id, email, name, role, scope, status) VALUES
  ('MEM-000001', 'theosyl@icloud.com', 'ShaoYi', 'admin', 'personal_corp', 'active'),
  ('MEM-000002', 'wu.plhojita@gmail.com', 'PeiLing', 'accountant', 'corp', 'active');

-- 分類樹、供應商主檔、採購/資產/文件等業務資料一律留空,由實際使用時建立
-- (分類樹可在管理後台「分類樹與檔名模板」頁籤新增,見規格文件 2.7)。
