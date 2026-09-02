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

## 現況(2026-09-02)

後端骨架已完成第一版:

- `packages/db`:用 Drizzle ORM 定義 13 張 D1 表(members / vendors / vendor_aliases / categories /
  purchases / purchase_tags / assets / documents / document_fields / processing_history /
  transfers / activity_log / id_sequences),migration 已用 `pnpm generate` 產生在
  `packages/db/migrations/`,套用方式見該資料夾的 README。
- `packages/domain`:關聯評分演算法(`matching.ts`)、供應商主檔強制覆核規則
  (`vendor-matching.ts`)、人類可讀 ID 格式、文件處理管線 8 步驟定義。
- `packages/shared`:R2 物件 key 規則、檔名模板、金額格式化(一律以「分」存放)。
- `apps/api`:掛上 D1 client、RBAC middleware(依 email 查 members 表決定 role/scope)、
  vendors / purchases / assets / documents / transfers / members / activity 的 CRUD 路由,
  `documents.ts` 內含 OCR 結果回寫、供應商比對、SHA-256 重複偵測、關聯候選評分、覆核歸檔等
  核心工作流程。

詳細規格來源見 Cowork 專案文件 `paraacco-integration/vaultlink-v2-design-spec-20260902.md`。

尚未開始:`apps/web`(Next.js 前端,目前仍是 placeholder 頁面)、`apps/document-worker` 的實際
OCR 串接、D1 migration 尚未套用到遠端(需要手動 `wrangler d1 migrations apply`,見
`packages/db/migrations/README.md`)。
