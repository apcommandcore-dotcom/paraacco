# 每日批次進件 API 規格(給排程腳本用)

**日期**：2026-09-13,2026-09-14 更新(Service Token 測試結果)
**對應**：`paraacco-code-handoff-package-20260913.md`/`_3.md` 第 5 節、
`paraacco-doc-classification-architecture-20260912.md` 第 4 節

## 2026-09-14 更新:Service Token 能通過 Access 邊緣,但還有一個關鍵問題沒驗證

你已經建立 Access Service Token(範圍限定 `acco-api.parallelserver.org/api/documents`),
curl 帶 `CF-Access-Client-Id`/`CF-Access-Client-Secret` 打 `GET /api/documents` 拿到
200 + JSON 清單——這證明了 Service Token 確實能通過 Cloudflare Access 的邊緣檢查,我之前
「Service Token 這條路走不通」的判斷下得太早、太武斷,先在這裡更正。

**但這個測試還不能證明 `POST /api/documents`(排程腳本實際要打的端點)也會成功**,原因是
這兩個端點在 `apps/api` 內部的驗證邏輯不一樣:

- `GET /api/documents`(你測過的)—— 只要求請求通過 Cloudflare Access(拿到有效簽章的
  JWT),不檢查 JWT 裡有沒有 `email`,也不查 `members` 表,所以就算 Service Token 的 JWT
  沒有可用的身分資訊,這支端點一樣會回 200。
- `POST /api/documents`(排程腳本要打的)—— 多一層 `canWrite(auth.scope)` 檢查(見
  `apps/api/src/routes/documents.ts:113`),`auth.scope` 是從 JWT 的 `email` claim 去查
  `members` 表對應的成員記錄算出來的(見 `apps/api/src/middleware/auth.ts`)。如果 Service
  Token 的 JWT 沒有 `email`,或 `email` 不對應 `members` 表裡的任何一筆(目前只有
  `theosyl@icloud.com`、`wu.plhojita@gmail.com` 兩筆),這裡會直接回 **403**,不管 request
  body 寫得多正確都一樣。

**麻煩你先跑這個診斷,結果會決定接下來走哪條路**:

```bash
curl https://acco-api.parallelserver.org/api/whoami \
  -H "CF-Access-Client-Id: <你的 Client ID>" \
  -H "CF-Access-Client-Secret: <你的 Client Secret>"
```

`/api/whoami` 直接把 JWT 解出來的 `email`/`name` 回傳(不查 `members` 表,純粹顯示 JWT 裡有
什麼),兩種結果對應兩條路:

### 結果 A:`email` 是 `null`(或整個回應是 `{"email":null,"name":null}`)

Service Token 的 JWT 確實沒有可用的 `email` claim,`POST /api/documents` 一定會 403。這種
情況下有兩個選擇:

1. **改用我已經寫好的 `/api/batch-import/documents`**(見下方「方案 B」)——不依賴
   `email`/`members` 表,獨立的共用密鑰驗證,不需要改任何核心驗證程式碼。
2. 或者告訴我你想繼續走 Service Token 這條路,我把 `access-jwt.ts` 改成也認得 JWT 的
   `common_name` claim,在 `members` 表建一個對應的「服務帳號」列——技術上做得到,但會把
   服務帳號的身分邏輯混進本來只處理真人登入的程式碼裡,個人建議用方案 1 比較乾淨。

### 結果 B:`email` 有值(不是 null)

代表 Service Token 的 JWT 確實帶了可用的 email——把這個值告訴我,我在 `members` 表幫它建
一筆對應記錄(`role` 用一個能寫入的角色,`scope: 'corp'`),之後就能直接用 Service Token +
既有的 `POST /api/documents` 端點,不需要用到下面的 `/api/batch-import/documents`。

---

## 方案 A:既有的 `POST /api/documents`(需要結果 B,或幫 Service Token 建 members 記錄)

這是你這次問的端點,規格如下。

### 上傳流程(兩步驟)

`POST /api/documents` 本身**不接收檔案二進位內容**,只負責「登記」——檔案要先送進 R2,
兩種送法擇一:

**方式 1(建議,跟網頁前端同一套邏輯)**:

```bash
# 第 1 步:拿預簽 URL
curl -X POST https://acco-api.parallelserver.org/api/uploads/presign \
  -H "CF-Access-Client-Id: <Client ID>" -H "CF-Access-Client-Secret: <Client Secret>" \
  -H "Content-Type: application/json" \
  -d '{"fileName": "發票.pdf", "mimeType": "application/pdf"}'
# 回應:{ "uploadUrl": "...", "r2Key": "documents/uploads/<uuid>/發票.pdf", "expiresIn": 600 }

# 第 2 步:直接 PUT 檔案到 R2(這一步不用帶 Access header,uploadUrl 本身已經簽好)
curl -X PUT "<uploadUrl>" --data-binary @/path/to/發票.pdf

# 第 3 步:登記 documents(見下方 body 規格)
curl -X POST https://acco-api.parallelserver.org/api/documents \
  -H "CF-Access-Client-Id: <Client ID>" -H "CF-Access-Client-Secret: <Client Secret>" \
  -H "Content-Type: application/json" \
  -d '{ "ownership": "corp", "fileName": "發票.pdf", "mimeType": "application/pdf", "byteSize": 123456, "r2Key": "documents/uploads/<uuid>/發票.pdf", "source": "api_import", "ingestChannel": "local-scanner-batch" }'
```

**方式 2(單一請求,後端代傳)**:`POST /api/uploads`(multipart/form-data,欄位 `file`)
一次完成上傳,回應直接給 `r2Key`/`byteSize`/`sha256`,拿到之後一樣打第 3 步登記。這支是
原本設計給「網路環境擋 R2 直連」時的備援路徑,對排程腳本來說也比較簡單(少一步),兩者選
一種都可以,沒有強制規定。

### `POST /api/documents` Body 規格

```json
{
  "ownership": "corp",
  "fileName": "發票.pdf",
  "mimeType": "application/pdf",
  "byteSize": 123456,
  "r2Key": "documents/uploads/<uuid>/發票.pdf",
  "sha256": "選填,方式 2(/api/uploads)會回傳,方式 1(預簽直傳)沒有,不影響 pipeline",
  "source": "api_import",
  "ingestChannel": "local-scanner-batch"
}
```

| 欄位 | 必填 | 說明 |
|---|---|---|
| `ownership` | 是 | 固定填 `"corp"` 佔位即可——Gemini 判讀階段(stage 5 classifying)會用判讀出的範圍覆蓋成正確值,這裡填什麼不影響最終結果,只影響 pipeline 跑完之前的短暫顯示 |
| `fileName` | 是 | 原始檔名 |
| `mimeType` | 是 | 檔案的 MIME type |
| `byteSize` | 是 | 檔案位元組數 |
| `r2Key` | 是 | 上傳步驟拿到的 R2 物件 key |
| `sha256` | 否 | 方式 2 會提供,方式 1 沒有也沒關係 |
| `source` | 是 | **固定填 `"api_import"`**——不是新值,沿用既有的 4 個合法值之一(`documents.source` 的 DB CHECK 約束只允許 `web_upload`/`mobile_scan`/`email_forward`/`api_import`,語意上批次腳本本來就是「程式化呼叫 API」,跟其他 api_import 文件是同一種進件管道) |
| `ingestChannel` | 否,但你要的話填 `"local-scanner-batch"` | **這是應用層的進件管道標記,不是 DB 欄位/CHECK 約束**——見下方「為什麼是 ingestChannel 不是新的 source 值」。有帶的話會被寫進 `document_extracted_fields`(`fieldKey: 'ingest_channel'`),供之後篩選/除錯「這筆是不是批次進件產生的」用 |

### 回應

同方案 B 的回應格式:成功 `201 { "ok": true, "id": "DOC-2026-000123" }`,失敗格式見下方方案
B 的「回應」段落(`documentsRoute` 跟 `batchImportRoute` 底層共用同一段登記邏輯
`document-ingest.ts` 的 `registerDocument()`,回應形狀一致)。

---

## 方案 B:`/api/batch-import/documents`(獨立密鑰驗證,不依賴 email/members 表)

如果診斷結果是 A(Service Token 沒有可用 email),或你就是想要一支不依賴人類登入邏輯的
端點,用這支——已經寫好、已 push(commit `c6fcd45`)。

### 需要 Theo 額外設定(如果走這條路)

```bash
cd /Users/lushaoyi/dev/paraacco/apps/api
npx wrangler secret put LOCAL_SCANNER_TOKEN
```

輸入一組長隨機字串(例如 `openssl rand -hex 32` 產生)。另外需要在 Cloudflare Zero Trust
加一條 **Bypass** 政策,Path 限定 `acco-api.parallelserver.org/api/batch-import/*`(不是用
你已經建立的 Service Token——這支端點刻意不用 Access 驗證身分,見下方原因)。

### 端點

```
POST https://acco-api.parallelserver.org/api/batch-import/documents
```

### Headers

| Header | 值 |
|---|---|
| `X-Local-Scanner-Token` | `<LOCAL_SCANNER_TOKEN>`,不對回 403 |

### Body

`multipart/form-data`,單一欄位 `file`(二進位檔案內容,PDF 或圖片,≤25MB)。`ownership`
固定填 `'corp'`、`source` 固定填 `'api_import'`、`ingestChannel` 固定填
`'local-scanner-batch'`,這三個在伺服器端寫死,不用/不能從 request 帶入。

### 回應

**成功**(`201`):`{ "ok": true, "id": "DOC-2026-000123" }`

**失敗**:
- `400 { "error": "missing file field" }`
- `403 { "error": "forbidden" }`(方案 A 是 `X-Local-Scanner-Token` 不對,方案 B 是同一組
  header 不對)
- `413 { "error": "file too large", "maxBytes": 26214400 }`
- `500 { "error": "internal_error", "message": "..." }`

### 範例

```bash
curl -X POST https://acco-api.parallelserver.org/api/batch-import/documents \
  -H "X-Local-Scanner-Token: <LOCAL_SCANNER_TOKEN>" \
  -F "file=@/path/to/掃到的檔案.pdf"
```

```python
import requests
resp = requests.post(
    "https://acco-api.parallelserver.org/api/batch-import/documents",
    headers={"X-Local-Scanner-Token": LOCAL_SCANNER_TOKEN},
    files={"file": open(file_path, "rb")},
    timeout=60,
)
resp.raise_for_status()
doc_id = resp.json()["id"]
```

---

## 為什麼是 `ingestChannel` 應用層標記,不是新的 `source` DB 值

原本任務書第 5 節規劃 `source: 'local-scanner-batch'`——實際嘗試在 `documents.source` 的
DB CHECK 約束加這個新值時,踩到 Cloudflare D1 的平台限制:`documents` 表被
`document_files`/`document_extracted_fields`/`document_processing_jobs`/
`document_purchase_links`/`document_asset_links`/`relation_candidates` 六張表用外鍵參照,
SQLite 改 CHECK 約束需要整表重建(`CREATE __new_table` → `INSERT...SELECT` → `DROP TABLE`
→ `RENAME`),但 D1 不遵守 `PRAGMA foreign_keys=OFF`/`defer_foreign_keys`(本機用最小案例
—— 兩張表、一筆外鍵參照——重現確認,不是資料問題),`DROP TABLE documents` 一律直接觸發
外鍵違規,正式環境套用時整批回滾,詳細除錯過程見
`CODE_REPORT_d1-fk-rebuild-limitation_20260913.md`。

改用不需要 migration 的方案:`source` 一律填既有合法值 `'api_import'`,另外用
`ingestChannel` 這個應用層欄位(寫進 `document_extracted_fields`,不是 `documents` 表的
新欄位)標記「這筆是不是批次進件產生的」,兩支端點(`/api/documents`、
`/api/batch-import/documents`)都支援。

## 兩種來源、同一支端點(不管走方案 A 或 B)

架構文件第 5 節提到的兩個來源(憑證類 `smb://192.168.20.91/Scanner/Bookkeeper_Scanner`、
對帳類 `smb://192.168.20.91/ATLPAR_Bookkeeper/Paraacco_公司財務系統`)都打同一支端點,沒有
欄位區分——文件進了 pipeline 之後,Gemini 判讀階段(`financeDocType` 分類,`BANK`/`CC`
對應銀行/信用卡對帳單)會自己判斷是不是對帳類文件。

**目前的限制**:對帳類文件判讀出來之後,要真的拆解成 `statement_lines` 明細列(供自動勾稽
比對使用)的 Gemini 判讀 pipeline 分支還沒做(目前完成的是「明細列已經存在時怎麼比對」,
見 `packages/domain/src/reconciliation.ts`)。這表示現階段對帳類文件上傳後,會被當成一般
單一憑證處理,不會自動產生勾稽比對結果——不影響你先開始測憑證類的批次進件。
