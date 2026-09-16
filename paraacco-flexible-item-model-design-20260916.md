# 彈性標籤項目模型 — 設計決定與實作記錄

**日期**：2026-09-16
**對應**：`CODE_TASK_flexible-item-object-model_20260916.md`
**性質**：這次直接動工(照任務書指示),不是等 Theo 拍板的開放式評估。已完成的部分是
決定+程式碼,還沒動工的部分(新瀏覽畫面本身)明確標示原因跟依賴。

## 已完成(程式碼)

### 1. `asset_tags` 表——已建立

比照既有 `purchase_tags`(`assetId` + `tag`,自由文字,複合主鍵),全新表,不影響
`assets`/`documents` 既有欄位。`assets.ts` 的 `POST /`/`GET /:id` 已經接上(建立時可以帶
`tags: string[]`,詳情端點回傳 `tags`)。

**沒有做 `document_tags`——這是刻意的設計決定,理由**:標籤是「使用者建立/編輯的項目
(item)」這個概念底下的東西,項目落地後是 `purchases` 或 `assets` 的一列。原始 `documents`
可能同時是好幾個不同項目的來源憑證(這正是這次要支援的核心情境——一張發票拆多個項目),
幫「文件本身」貼標籤語意上會混淆:是哪個項目的標籤?標籤應該跟著使用者實際在操作的項目走,
不是跟著原始憑證走。如果之後真的出現「需要在文件層級標記,不掛在任何項目下」的情境,再另外
評估,現在不需要。

### 2. 「一份文件拆成多個項目」的建檔流程——已確認/補齊後端支援

**發現**:`assets.ts` 的 `POST /` 早在 09-08 的補完設計落差任務(任務 2,手動新增資產)就
已經支援 `linkDocumentId`(建立當下順便連結一份既有文件,寫進 `document_asset_links`)。
`purchases.ts` 沒有對應能力——這是唯一真正缺的部分,已經補上,直接比照 `assets.ts` 的寫法:

- `POST /api/purchases` 新增 `linkDocumentId` 選填欄位,建立時寫進
  `document_purchase_links`(`relationKind: 'primary'`、`linkedBy: 'manual'`)。
- 同一個 `linkDocumentId` 可以連續呼叫這支端點好幾次、每次帶不同的 `summary`/`tags`/金額,
  拆成好幾筆各自獨立的採購案,全部連回同一份來源文件,互不覆蓋——`document_purchase_links`
  本身就是多對多(複合主鍵 `documentId` × `purchaseId`),schema 本來就支援,不用改。
- `GET /api/purchases/:id` 補上 `documentLinks`(比照 `assets.ts` 既有的回傳形狀),詳情頁
  能看到這筆項目連回了哪些文件。

**這代表「從一份文件建立多個獨立項目」這件事,後端 API 現在已經可以直接做**:前端流程會是
「在文件詳情/待覆核畫面,對同一份文件連續按幾次『建立為新項目』,每次填不同的標題/標籤/
金額」——UI 本身還沒做(見下方「還沒做」),但不需要等後端。

**關鍵路徑測試**(`test/flexible-items.test.ts`):驗證同一個 `linkDocumentId` 建兩筆採購案
互不覆蓋、各自的 `documentLinks` 正確;資產標籤建立+讀回。5 個新測試,連同既有測試共 28 個
全綠。

### 3. 標題編輯與 OCR 覆蓋規則——已確認現況,不需要新機制

查證結果(不是猜的,`grep` 過 `apps/api/src`、`apps/document-worker/src` 所有寫入
`purchases`/`assets` 的地方):**目前完全沒有任何自動化流程會寫入 `purchases.summary` 或
`assets.name`**——所有寫入都在人類使用者的路由裡(`routes/purchases.ts`、`routes/assets.ts`
的編輯端點、`routes/transfers.ts` 的歸屬移轉),OCR pipeline(`internal/documents.ts`)只
寫 `documents` 表跟 `document_extracted_fields`,從來不碰 `purchases`/`assets`。

**結論**:「編輯過的標題會不會被 OCR 重跑覆蓋」這個風險,在**現有架構下不存在**——因為
`purchases`/`assets` 從來就不是 OCR 自動建立/更新的,一律是人類透過 API 手動建立(即使是
「OCR 判讀完自動生成預設標題」這個情境,也是**人類按下『建立為新項目』的當下**,由前端把
OCR 擷取到的欄位值當作預設值帶進建立表單,不是背景自動寫入)。所以不需要另外做
`isUserConfirmed` 這一類的保護欄位——現在就是「使用者確認過才會真的寫進 `purchases`」。

**唯一需要記住的前瞻性提醒**:如果之後真的要做「文件進 pipeline 就自動建立項目,不用人工
按建立」這種更進一步的自動化(這次任務書沒有要求,是我讀完現況後想到要先講清楚的邊界),
那時候才需要比照 `document_extracted_fields.isUserConfirmed` 的規則(人工確認過的欄位不可
被之後重跑的自動流程靜默覆蓋),現在不用先做。

### 4. `document_case_links` 跟 `document_purchase_links`/`document_asset_links` 的分工

已經在 schema 的表定義註解裡寫清楚(`packages/db/src/schema.ts`),摘要如下,兩者是互補、
不衝突的兩種關聯,可以同時作用在同一份文件上:

| | 連結對象 | 用途 |
|---|---|---|
| `document_purchase_links` / `document_asset_links` | 文件 ↔ 項目(採購案/資產) | 這份文件是「哪個項目的憑證」 |
| `document_case_links` | 文件 ↔ 文件(不涉及項目) | 同一件事底下,原始文件彼此的關係(繳費單→催繳→收據 的時間序列鏈,或發票+保證書+說明書 的同來源群組) |

舉例:一份「收據」文件可以**同時**:①是某個健保費案件鏈裡的「收據」階段
(`document_case_links`,`role: 'receipt'`)、②是某筆採購案的憑證
(`document_purchase_links`,`relationKind: 'primary'`)——兩套資料互不影響,各自查詢,不會
打架。

`document_case_links` 的 `role` 字典已經按 `paraacco-document-case-links-design-evaluation-
20260916.md` 第 2 節的決定擴充完整(帳單流程 5 碼 + 沿用 `docTypeCode` 的資產購買 7 碼,共
12 個合法值),直接建表,不用之後再遷移一次。**這張表已經建好(migration 已產生),但正式
環境還沒套用**——見下方「需要你做的事」。

## 還沒做(需要依賴前一輪「依標題瀏覽」的懸而未決問題)

**新的「依標題瀏覽」畫面本身還沒開始做**——不是忘記,是這件事依賴
`paraacco-browse-by-title-design-evaluation-20260916.md` 最後列的 3 個待確認問題(category
要不要分層、SHR 要不要提前、要不要先給一份 vendor/category 清單),你還沒回覆。這次任務書
第 4 節要「把彈性標籤項目整合進依標題瀏覽入口」,但入口本身的結構還沒定案,沒辦法在這輪
一起把畫面做出來——**這不是又要你等一輪新評估,是同一輪評估裡本來就還沒收斂的 3 個問題,
麻煩優先回這幾個**,回覆之後新畫面(分類/供應商清單 → 項目清單,標籤當篩選維度)可以直接
照這次確認的資料模型(彈性標籤項目 + `document_case_links` + `document_purchase_links`/
`document_asset_links`)動工,不會再卡。

在那之前,`asset_tags`/`document_case_links`/`linkDocumentId` 這些後端能力已經到位,你可以
先透過既有的 API(或之後補的簡單表單)開始用「一份文件拆多個項目」這個流程,不用等新畫面
做完才能用。

## 需要你做的事

正式環境套用新 migration(`0004_wonderful_rattler.sql`,只有兩張全新表,不動既有資料,
安全性等同之前的 `entities`/`projects`/`statement_lines`):

```bash
cd /Users/lushaoyi/dev/paraacco/packages/db && npx wrangler d1 migrations apply paraacco-db --remote
```
