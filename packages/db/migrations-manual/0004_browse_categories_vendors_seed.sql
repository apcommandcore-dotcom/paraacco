-- categories/vendors 初始資料 —— 2026-09-16「依標題瀏覽」入口新增,對應
-- paraacco-browse-by-title-design-evaluation-20260916.md 第 1 節(分類→供應商兩層)。
-- 不是 drizzle-kit 產生的 migration,不會被 `wrangler d1 migrations apply` 自動套用。
-- 用法:wrangler d1 execute paraacco-db --remote --file=./migrations-manual/0004_browse_categories_vendors_seed.sql
--
-- 只放 Track 1 backlog 已經有實際 OCR 資料佐證的 3 筆(見
-- CODE_TASK_browse-by-title-open-questions-decision_20260916.md 第 3 節),NAS 上還有
-- 資料夾佔位但 vendor 明細還沒 OCR 確認的分類(水電瓦斯還缺台灣電力/陽明山瓦斯、勞健保還缺
-- 勞保局等)故意不編造,等 Track 1 backlog 實際處理到再補下一批 seed。
--
-- ownershipScope 註記(重要,設計取捨說明):Theo 決定分類樹維持單層、不疊 FAM/ORG/SHR,
-- 用「既有的 ownershipScope 篩選/切換」而不是把 FAM/ORG/SHR 併進分類樹第一層——但
-- categories.ownership_scope 目前是每個分類列只能填一個值的 NOT NULL 欄位(schema 沿用
-- 2026-09-02 定案時的設計,那時候假設分類是 per/corp 互斥的)。這裡填 'corp' 只是滿足
-- NOT NULL 約束、也符合這 3 個分類目前實際 OCR 出來的分類結果(中華電信/健保/自來水這批
-- 目前確認的資料全部是 ORG 範疇),但**依標題瀏覽的實際範圍篩選不會依賴這個欄位**——
-- 用既有的全域範圍切換器(documents/purchases.ownership)動態篩選底下的文件/採購案,
-- categories.ownership_scope 對這個功能來說目前形同虛設,不要誤以為改這個欄位就能讓某個
-- 分類「變成」家庭用,那不是這個欄位現在實際的作用範圍。

INSERT INTO categories (id, ownership_scope, parent_id, name) VALUES
  ('telecom', 'corp', NULL, '電信'),
  ('insurance', 'corp', NULL, '勞健保'),
  ('utilities', 'corp', NULL, '水電瓦斯');

INSERT INTO vendors (id, name, tax_id, default_ownership, default_category_id) VALUES
  ('vendor-cht', '中華電信股份有限公司', '81691784', 'corp', 'telecom'),
  ('vendor-nhi', '衛生福利部中央健康保險署', NULL, 'corp', 'insurance'),
  ('vendor-taipei-water', '臺北自來水事業處', '03774909', 'corp', 'utilities');
