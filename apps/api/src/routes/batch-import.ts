// 每日批次進件(見 paraacco-doc-classification-architecture-20260912.md 第 4 節、
// paraacco-code-handoff-package-20260913_3.md 第 5 節)—— Theo 本機/NAS 排程腳本(掃描機
// 資料夾 + 對帳單資料夾)呼叫這裡,一次完成「檔案存進 R2 + 登記 documents/document_files +
// 開 processing job + 送進 DOCUMENT_QUEUE」,跟 routes/uploads.ts + routes/documents.ts
// 分兩支端點做的事一樣,合成一支是為了排程腳本每個檔案只要打一次 HTTP 請求,不用像網頁前端
// 那樣先拿預簽 URL 再另外呼叫建立 documents 記錄。
// 2026-09-28:原始檔只留 NAS,「檔案存進 R2」這段已停用(/documents 回 410),改由
// /documents-local 只登記 NAS 相對路徑與 SHA-256,見下方。
//
// 驗證方式(不是 Cloudflare Access,也不是 internal-auth 那組密鑰,見 middleware/
// batch-auth.ts):排程腳本跑在 Cloudflare 網路之外,打 HTTPS 進來一定會先經過
// acco-api.parallelserver.org 前面的 Cloudflare Access 邊緣檢查——這裡的共用密鑰驗證只是
// Worker 內部這一層,Access 那一層需要另外處理,兩種做法擇一:
//
//   (建議)在 Cloudflare Zero Trust dashboard 對 Access → Applications →
//   「AP Internal Platform」新增一條 Bypass 政策,Path 限定成
//   `acco-api.parallelserver.org/api/batch-import/*`——只有這一條路徑跳過 Access 檢查,
//   跟人類使用者的其他所有路徑(包含 /api/documents、/api/whoami 等)完全不受影響,安全性
//   驗證完全交給這裡的共用密鑰(X-Local-Scanner-Token),攻擊面限定在單一路徑。
//
//   (不建議,但列出來給 Theo 參考)申請 Access Service Token(Access → Service Auth →
//   Create Service Token),排程腳本改帶 CF-Access-Client-Id/CF-Access-Client-Secret。這個
//   做法行不通的原因:Service Token 通過 Access 驗證後,Access 簽發的 JWT 用
//   `common_name`(token 名稱)識別身分,不是 email——但 apps/api 的人類驗證邏輯
//   (whoami.ts/access-jwt.ts)只認 JWT 裡的 `email` claim,沒有 email 的請求會被當成
//   「沒有登入身分」擋下來。要讓這條路走得通,還需要另外修改 access-jwt.ts 認得
//   `common_name`、在 members 表建一個對應的服務帳號列——比 Bypass 政策多繞一手,也把
//   服務帳號的身分邏輯混進本來只處理真人登入的驗證程式碼裡,不建議這樣做。

import { Hono } from "hono";
import { createDb } from "@paraacco/db";
import { validateLocalPath } from "@paraacco/shared";
import type { Bindings } from "../bindings";
import { registerDocumentDetailed } from "../document-ingest";

export const batchImportRoute = new Hono<{ Bindings: Bindings }>();

const OWNERSHIP_VALUES = ["per", "corp", "advance", "custody"] as const;

// 2026-09-28 起原始檔只留 NAS(CODE_TASK_local-originals-nas-path_20260927_V1.01.md):R2 不再收新檔。
// 舊的 multipart 上傳端點(檔案存進 R2)回 410,改用下面的 /documents-local。下一版再刪路由。
batchImportRoute.post("/documents", (c) =>
  c.json(
    {
      error: "gone",
      message: "R2 已停止收新檔。每日進件改用 POST /api/batch-import/documents-local(只登記 NAS 路徑與 SHA-256,不傳檔案),見 scripts/batch-ingest_V1.03.sh。",
    },
    410,
  ),
);

// 每日進件(NAS 原檔版)—— scripts/batch-ingest_V1.03.sh 把 Bookkeeper_Scanner 的檔案複製到
// Paraacco_公司財務系統/00_收件/YYYYMMDD/、驗證 SHA-256 後呼叫這裡。不收檔案本身,只登記
// document + document_files(storage='local'),再排入 DOCUMENT_QUEUE。document-worker 在
// storage='local' 時不讀 R2、不呼叫 Gemini,等外部判讀寫回(見 apps/document-worker/src/workflow.ts)。
//
// localPath 可含 `{id}`:登記時換成配到的 DOC id,回應帶回實際路徑,腳本照這個名字在 NAS 上改名
// (00_收件/20260928/{id}.pdf → DOC-2026-000720.pdf),不用再打一次歸檔回寫端點。
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_BYTES = 200 * 1024 * 1024; // 只是登記 metadata,上限只為擋掉明顯錯誤的值。

batchImportRoute.post("/documents-local", async (c) => {
  const body = await c.req
    .json<{ fileName?: unknown; byteSize?: unknown; mimeType?: unknown; sha256?: unknown; localPath?: unknown; ownership?: unknown }>()
    .catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);

  const { fileName, byteSize, mimeType, sha256, localPath, ownership } = body;
  if (typeof fileName !== "string" || !fileName.trim() || fileName.length > 255) return c.json({ error: "invalid_file_name" }, 400);
  if (typeof byteSize !== "number" || !Number.isInteger(byteSize) || byteSize < 0 || byteSize > MAX_BYTES) {
    return c.json({ error: "invalid_byte_size" }, 400);
  }
  if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) return c.json({ error: "invalid_sha256", message: "sha256 必須是 64 碼小寫十六進位" }, 400);
  if (mimeType !== undefined && typeof mimeType !== "string") return c.json({ error: "invalid_mime_type" }, 400);
  const pathError = validateLocalPath(localPath);
  if (pathError) return c.json({ error: "invalid_local_path", message: pathError }, 400);

  // 可選的預標歸屬(歷史回填用,見 CODE_TASK_archive-backfill-ownership-hint_20260918.md)——
  // 有傳就視為呼叫端已確認,分類階段不覆蓋;沒傳維持原本的 'corp' 佔位、照樣被判讀結果覆蓋。
  let ownershipHint: (typeof OWNERSHIP_VALUES)[number] | null = null;
  if (ownership !== undefined && ownership !== null && ownership !== "") {
    if (typeof ownership !== "string" || !(OWNERSHIP_VALUES as readonly string[]).includes(ownership)) {
      return c.json({ error: "invalid ownership", allowed: OWNERSHIP_VALUES }, 400);
    }
    ownershipHint = ownership as (typeof OWNERSHIP_VALUES)[number];
  }

  const db = createDb(c.env.DB);
  const { id, localPath: storedPath } = await registerDocumentDetailed(db, c.env.DOCUMENT_QUEUE, {
    ownership: ownershipHint ?? "corp",
    ownershipConfirmed: ownershipHint !== null,
    fileName: fileName.trim(),
    mimeType: (mimeType as string | undefined) || "application/octet-stream",
    byteSize,
    sha256,
    storage: "local",
    localPath: localPath as string,
    source: "api_import",
    ingestChannel: "local-scanner-batch",
    actorMemberId: null,
  });

  return c.json({ ok: true, id, localPath: storedPath }, 201);
});
