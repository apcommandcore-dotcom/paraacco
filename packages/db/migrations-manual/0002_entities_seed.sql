-- entities 初始資料 —— 2026-09-13 財務文件自動分類架構新增,只有 2 筆,人工維護。
-- 不是 drizzle-kit 產生的 migration,不會被 `wrangler d1 migrations apply` 自動套用。
-- 用法:wrangler d1 execute paraacco-db --remote --file=./migrations-manual/0002_entities_seed.sql
--
-- 「平行空間室內裝修有限公司」曾在文件(借據)上單獨出現,已確認是平行空間有限公司的別名,
-- 不是獨立法人,故不建立第三筆。
--
-- 2026-09-13 晚間修正:studio 的統編原本填成 158464165(錯誤值),正確值是 60277434。
-- 正式環境的資料 Theo 已經自行修正過,這裡只是同步修正原始檔案,避免下次有人重新套用這份
-- seed 時又套回錯誤值——不需要對正式環境重跑。

INSERT INTO entities (id, name, tax_id) VALUES
  ('ap', '平行空間有限公司', '83018456'),
  ('studio', '呂劭翊建築師事務所', '60277434');
