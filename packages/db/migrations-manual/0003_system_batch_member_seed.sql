-- 系統/批次帳號初始資料 —— 2026-09-14 新增,給每日批次進件排程腳本用的 Access Service
-- Token 對應一筆 members 記錄(見 apps/api/src/access-jwt.ts 的 COMMON_NAME_ALLOWLIST)。
-- 不是 drizzle-kit 產生的 migration,不會被 `wrangler d1 migrations apply` 自動套用。
-- 用法:wrangler d1 execute paraacco-db --remote --file=./migrations-manual/0003_system_batch_member_seed.sql
--
-- email 是合成值(不是真的信箱,不會有人收到這個地址的信),必須跟
-- access-jwt.ts 的 COMMON_NAME_ALLOWLIST["28ef77a8a2c18f97310e963b4b19d98c.access"].email
-- 完全一致,這個對應關係是 Service Token 能不能通過 canWrite() 檢查的關鍵——改了這裡記得
-- 同步改程式碼裡的白名單,兩邊對不起來的話 Service Token 打 POST /api/documents 會直接
-- 403(email 查不到對應的 member)。
--
-- role 用 'accountant'(有寫入權限,跟既有的 PeiLing 同一種角色,不是 'admin')——批次進件
-- 只需要能建立 documents/document_files/document_processing_jobs,不需要 admin 權限。
-- scope 用 'corp'——批次進件目前來源都是公司財務文件(掃描機/NAS 對帳資料夾),跟人類會計
-- 一樣的範圍。

INSERT INTO members (id, email, name, role, scope, status) VALUES
  ('MEM-SYSTEM-BATCH', 'local-scanner-batch@service.paraacco.internal', '本地掃描批次系統', 'accountant', 'corp', 'active');
