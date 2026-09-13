# 每日批次進件 API 規格(給排程腳本用)

**日期**：2026-09-13,2026-09-14 定案(Service Token + 既有 `/api/documents`)
**對應**：`paraacco-code-handoff-package-20260913.md`/`_3.md` 第 5 節、
`paraacco-doc-classification-architecture-20260912.md` 第 4 節

## 2026-09-14 定案:認證方式統一用 Cloudflare Access(Service Token)

Theo 決定不走共用密鑰(`/api/batch-import/documents`)那條路,理由是不想把 API 流量的認證
方式拆成兩套——維持所有請求都在 Cloudflare Access 這層有一致的邊界防護。程式碼已經改完:

- `apps/api/src/access-jwt.ts` 新增 `resolveIdentityFromPayload()`——JWT 有 `email` 時照舊;
  沒有 `email`(Service Token 認證的 JWT 就是這種情況)但有 `common_name` 時,查一份**明確
  白名單**(`COMMON_NAME_ALLOWLIST`)映射成一組合成 email,不是「任何 common_name 都放行」。
  你的 Service Token(`28ef77a8a2c18f97310e963b4b19d98c.access`)已經登記在白名單裡,對應
  `local-scanner-batch@service.paraacco.internal`。
- 這組合成 email 跟既有的「用 email 查 `members` 表」邏輯完全相容,`whoami.ts`/
  `middleware/auth.ts` 完全沒改——只要 `members` 表裡有這筆記錄,`POST /api/documents` 的
  `canWrite()` 檢查就會正常通過,跟真人登入走的是同一條程式碼路徑。
- 6 個新測試(`apps/api/test/access-jwt.test.ts`)涵蓋 payload 映射邏輯、資料庫查詢、實際
  呼叫 `POST /api/documents` 成功登記,本機全綠(沒辦法簽真的 Cloudflare JWT 測試,拆成
  「payload→身分」「身分→資料庫」「身分→API 呼叫」三段驗證,細節見 commit `090a75b`)。

**還差一步,需要你在正式環境執行**(auto-mode 安全機制不能寫 production,理由跟之前 tax_id
修正一樣):

```bash
cd /Users/lushaoyi/dev/paraacco/packages/db
npx wrangler d1 execute paraacco-db --remote --file=./migrations-manual/0003_system_batch_member_seed.sql
```

這會插入系統帳號(`MEM-SYSTEM-BATCH`,`email: local-scanner-batch@service.paraacco.internal`,
`role: accountant`,`scope: corp`)。套用完之後,建議跑一次診斷確認整條鏈路真的通:

```bash
curl https://acco-api.parallelserver.org/api/whoami \
  -H "CF-Access-Client-Id: <Client ID>" -H "CF-Access-Client-Secret: <Client Secret>"
# 預期:{"email":"local-scanner-batch@service.paraacco.internal","name":"本地掃描批次系統"}
```

拿到這個回應就代表 Service Token → 白名單映射 → members 查詢全部接通了,可以直接照下面的
規格串排程腳本。

---

## API 規格

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
一次完成上傳,回應直接給 `r2Key`/`byteSize`/`sha256`,拿到之後一樣打第 3 步登記。對排程
腳本來說比較簡單(少一步、不用自己組 multipart PUT),兩者選一種都可以,沒有強制規定。

**注意**:你的 Service Token 目前範圍限定在 `acco-api.parallelserver.org/api/documents`——
如果要用上面的預簽/上傳流程,Service Token 的範圍要擴大涵蓋 `/api/uploads/*` 才行,不然
第 1、2 步一樣會被 Access 攔在門外。

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
| `source` | 是 | **固定填 `"api_import"`**——不是新值,沿用既有的 4 個合法值之一(見下方「為什麼是 ingestChannel」) |
| `ingestChannel` | 否,但你要的話填 `"local-scanner-batch"` | 應用層的進件管道標記,不是 DB 欄位/CHECK 約束,有帶的話會被寫進 `document_extracted_fields`(`fieldKey: 'ingest_channel'`),供之後篩選/除錯用 |

### Headers

| Header | 值 |
|---|---|
| `CF-Access-Client-Id` | 你的 Service Token Client ID |
| `CF-Access-Client-Secret` | 你的 Service Token Client Secret |
| `Content-Type` | `application/json` |

### 回應

**成功**(`201`):
```json
{ "ok": true, "id": "DOC-2026-000123" }
```
`id` 是這份文件在 paraacco 裡的編號,可以記下來對應原始檔名,方便之後排錯或人工查詢。

**失敗**:
- `403`——Service Token 沒帶對、白名單套用還沒跑(見上面「還差一步」)、或範圍沒涵蓋這條
  路徑。用 `/api/whoami` 診斷(見上方)先排除「身分解析對不對」這一層,再往下查。
- `400`/`500` 等其他錯誤形狀同既有 API 慣例(`{ "error": "...", "message"?: "..." }`)。

### 範例(Python,實際排程腳本可能會用的語言)

```python
import requests

HEADERS = {
    "CF-Access-Client-Id": CLIENT_ID,
    "CF-Access-Client-Secret": CLIENT_SECRET,
}

# 方式 2:單一請求後端代傳(如果 Service Token 範圍有涵蓋 /api/uploads)
with open(file_path, "rb") as f:
    upload = requests.post(
        "https://acco-api.parallelserver.org/api/uploads",
        headers=HEADERS,
        files={"file": f},
        timeout=60,
    )
upload.raise_for_status()
u = upload.json()  # { r2Key, fileName, mimeType, byteSize, sha256 }

resp = requests.post(
    "https://acco-api.parallelserver.org/api/documents",
    headers={**HEADERS, "Content-Type": "application/json"},
    json={
        "ownership": "corp",
        "fileName": u["fileName"],
        "mimeType": u["mimeType"],
        "byteSize": u["byteSize"],
        "r2Key": u["r2Key"],
        "sha256": u["sha256"],
        "source": "api_import",
        "ingestChannel": "local-scanner-batch",
    },
    timeout=30,
)
resp.raise_for_status()
doc_id = resp.json()["id"]
```

排程腳本收到 `201` 且拿到 `id` 之後,才把 NAS 原始檔搬到歸檔位置(見架構文件第 5 節)。如果
回應不是 `201`,原始檔留在原地不要搬,下次排程會再試一次(憑證類來源資料夾是「每天全部
重新掃描」,不是比對上次執行紀錄)。

---

## 為什麼是 `ingestChannel` 應用層標記,不是新的 `source` DB 值

原本任務書第 5 節規劃 `source: 'local-scanner-batch'`——實際嘗試在 `documents.source` 的
DB CHECK 約束加這個新值時,踩到 Cloudflare D1 的平台限制:`documents` 表被
`document_files`/`document_extracted_fields`/`document_processing_jobs`/
`document_purchase_links`/`document_asset_links`/`relation_candidates` 六張表用外鍵參照,
SQLite 改 CHECK 約束需要整表重建(`CREATE __new_table` → `INSERT...SELECT` → `DROP TABLE`
→ `RENAME`),但 D1 不遵守 `PRAGMA foreign_keys=OFF`/`defer_foreign_keys`(本機用最小案例
——兩張表、一筆外鍵參照——重現確認,不是資料問題),`DROP TABLE documents` 一律直接觸發
外鍵違規,正式環境套用時整批回滾,詳細除錯過程見
`CODE_REPORT_d1-fk-rebuild-limitation_20260913.md`。

改用不需要 migration 的方案:`source` 一律填既有合法值 `'api_import'`,另外用
`ingestChannel` 這個應用層欄位(寫進 `document_extracted_fields`,不是 `documents` 表的
新欄位)標記「這筆是不是批次進件產生的」。

## 附註:`/api/batch-import/documents` 仍在 repo 裡,但不是這次採用的路徑

前一輪先做了一支獨立密鑰驗證的端點(`commit c6fcd45`,共用密鑰 `X-Local-Scanner-Token`,
不依賴 Cloudflare Access)。Theo 決定改走 Service Token 統一驗證後,這支端點就不是排程腳本
要打的端點了,但程式碼沒有刪除(還能用,只是目前規劃不採用)。**排程腳本請用上面的
`POST /api/documents`,不要用 `/api/batch-import/documents`。**

## 兩種來源、同一支端點

架構文件第 5 節提到的兩個來源(憑證類 `smb://192.168.20.91/Scanner/Bookkeeper_Scanner`、
對帳類 `smb://192.168.20.91/ATLPAR_Bookkeeper/Paraacco_公司財務系統`)都打同一支端點,沒有
欄位區分——文件進了 pipeline 之後,Gemini 判讀階段(`financeDocType` 分類,`BANK`/`CC`
對應銀行/信用卡對帳單)會自己判斷是不是對帳類文件。

**目前的限制**:對帳類文件判讀出來之後,要真的拆解成 `statement_lines` 明細列(供自動勾稽
比對使用)的 Gemini 判讀 pipeline 分支還沒做(目前完成的是「明細列已經存在時怎麼比對」,
見 `packages/domain/src/reconciliation.ts`)。這表示現階段對帳類文件上傳後,會被當成一般
單一憑證處理,不會自動產生勾稽比對結果——排進下一輪優先序第 2 項處理,不影響你現在先開始
測憑證類的批次進件。
