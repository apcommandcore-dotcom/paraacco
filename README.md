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

## 初始狀態

這是初始 scaffold,尚未串接實際的 Next.js / Hono / D1 邏輯,僅建立 monorepo 骨架與套件邊界,
供後續逐步開發。
