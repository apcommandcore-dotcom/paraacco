# paraacco

採購/資產/文件管理平台。Turborepo + pnpm workspaces 的套件化 monorepo,規劃部署在 Cloudflare
(Workers + D1 + R2)。

## 資料夾結構

```
apps/
  web/               # Next.js (App Router) 前端
  api/                # 後端 API(Hono,Cloudflare Workers)
  document-worker/     # OCR / 文件處理背景服務,不可直接寫 D1,只能呼叫 api 的既有端點
packages/
  db/                  # D1 schema、query 層,web/api/document-worker 共用同一份 schema
  domain/              # 核心業務邏輯與型別(採購/資產/文件模型)
  shared/              # 共用工具、型別、常數
  ui/                  # 共用 UI 元件
  ocr/                 # OCR 相關邏輯,由 document-worker 使用
  search/              # 搜尋/索引邏輯
```

## 開發規則

- 任何修正一律進新版號,不可覆蓋前一版;修改前先留存快照。詳見組織內部的
  `parallelserver_app_開發` 專案說明。
- `document-worker` 不可直接寫 D1,所有寫入一律呼叫 `apps/api` 的既有端點,確保寫入路徑有統一的
  驗證與稽核記錄。
- Cloudflare 資源命名慣例:D1 `paraacco-db`、R2 bucket `paraacco-files`。
- 目前沒有 dev/staging 環境規劃,若之後需要,請先在此文件記錄決定。

## 現況(2026-09-02,schema v2)

範圍決策(使用者確認):單一事務所,不做多租戶(organizations/users/memberships)拆分,維持扁平
`members` 表,paraacco 介面的實際使用者只有「公司會計」與「負責人」+ admin;OCR pipeline 採
Cloudflare Queues + Workflows,不是同步處理。詳見 `packages/db/src/schema.ts` 開頭註解。

後端骨架已完成第二版(schema v2):

- `packages/db`:用 Drizzle ORM 定義 18 張 D1 表(members / vendors / vendor_aliases / categories /
  purchases / purchase_tags / assets / documents / document_files / document_extracted_fields /
  document_purchase_links / document_asset_links / document_processing_jobs /
  document_processing_events / relation_candidates / transfers / activity_log / id_sequences),
  全面加上 CHECK 約束;另有手寫的 `document_fts`(SQLite FTS5 全文檢索,見
  `migrations-manual/0001_document_fts.sql` 與 `search.ts`)。migration 用 `pnpm generate` 產生在
  `packages/db/migrations/`,套用方式(含 migrations-manual 與 seed 的套用順序)見該資料夾的
  README。
- `packages/domain`:關聯評分演算法(`matching.ts`,含強識別欄位衝突淘汰、決標邊際
  `resolveAutoLink`)、OCR 整體信心分數加權計算(`confidence.ts`)、供應商主檔強制覆核規則
  (`vendor-matching.ts`)、人類可讀 ID 格式、文件處理管線 8 步驟定義(`pipeline.ts`,對齊
  `documents.status`)。
- `packages/shared`:R2 物件 key 規則(以 documentId/versionId 為主,脫鉤業務關聯)、檔名模板
  (SUB/BIL 拆分)、金額格式化(一律以「分」存放)。
- `packages/ocr`:OCR provider 抽象介面 + `MockOcrProvider`(尚未選定實際 OCR 供應商,見規格文件
  缺口清單第 1 點)。
- `apps/api`:人類使用者走 `/api/*`(Cloudflare Access + RBAC middleware),document-worker 的
  Workflow 步驟走 `/internal/*`(Service Binding + 共用密鑰,見 `middleware/internal-auth.ts`)。
  vendors / purchases / assets / documents / transfers / members / activity 的 CRUD 路由 +
  `/internal/documents/*`(檔案登記、重複偵測、欄位擷取、分類、供應商比對、關聯評分候選、
  自動關聯、最終決定)+ `/internal/jobs/*`(job 冪等 claim、進度更新、事件記錄)。
- `apps/document-worker`:Cloudflare Queue consumer(`queue()`,冪等 claim 避免 at-least-once
  重複投遞啟動兩個 Workflow 實例)+ `DocumentProcessingWorkflow`(`WorkflowEntrypoint`,8 個
  `step.do()` 步驟,呼叫 apps/api 的 `/internal/*` 端點寫入結果,自己不碰 D1)。

詳細規格來源見 Cowork 專案文件 `paraacco-integration/vaultlink-v2-design-spec-20260902.md`。

尚未開始:`apps/web`(Next.js 前端,目前仍是 placeholder 頁面)、實際 OCR 供應商串接(目前是
`MockOcrProvider` 佔位)、D1 migration 尚未套用到遠端、Cloudflare Queue/Workflow/Service
Binding 等資源尚未在 Dashboard 建立(見下方待辦)。
