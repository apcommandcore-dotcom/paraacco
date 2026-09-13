// 每日批次進件(見 paraacco-doc-classification-architecture-20260912.md 第 4 節、
// paraacco-code-handoff-package-20260913_3.md 第 5 節)—— Theo 本機/NAS 排程腳本(掃描機
// 資料夾 + 對帳單資料夾)呼叫這裡,一次完成「檔案存進 R2 + 登記 documents/document_files +
// 開 processing job + 送進 DOCUMENT_QUEUE」,跟 routes/uploads.ts + routes/documents.ts
// 分兩支端點做的事一樣,合成一支是為了排程腳本每個檔案只要打一次 HTTP 請求,不用像網頁前端
// 那樣先拿預簽 URL 再另外呼叫建立 documents 記錄。
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
import type { Bindings } from "../bindings";
import { registerDocument } from "../document-ingest";

export const batchImportRoute = new Hono<{ Bindings: Bindings }>();

const MAX_BYTES = 25 * 1024 * 1024; // 跟 routes/uploads.ts 的 MAX_BYTES 一致,單據 PDF/照片綽綽有餘。

// 每日批次進件的來源只有兩種(見架構文件第 4 節):憑證類(掃描機資料夾)、對帳類(NAS 對帳
// 資料夾)。兩者目前都當一般文件登記進 documents 表走 8 步驟 pipeline——對帳單明細列
// (statement_lines)的拆解邏輯是後續勾稽 Workflow 的事,這支端點只負責「檔案進來、
// pipeline 開始跑」,不在這裡分流。
batchImportRoute.post("/documents", async (c) => {
  const form = await c.req.formData();
  const entry = form.get("file");
  if (typeof entry === "string" || entry === null) return c.json({ error: "missing file field" }, 400);
  const file = entry as unknown as { name: string; type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> };
  if (typeof file.arrayBuffer !== "function") return c.json({ error: "missing file field" }, 400);
  if (file.size > MAX_BYTES) return c.json({ error: "file too large", maxBytes: MAX_BYTES }, 413);

  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const safeName = file.name.replace(/[^\w.\-一-鿿]/g, "_") || "upload";
  const r2Key = `documents/uploads/${crypto.randomUUID()}/${safeName}`;

  await c.env.FILES.put(r2Key, bytes, {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });

  const db = createDb(c.env.DB);
  const id = await registerDocument(db, c.env.DOCUMENT_QUEUE, {
    // 批次進件目前一律先給 'corp' 佔位——階段 5(classifying)會用 Gemini 判讀出的 scope
    // 覆蓋成正確的 ownership(見 @paraacco/domain 的 classifyDocument()),這裡填什麼只影響
    // pipeline 跑完之前的短暫顯示,不是最終結果。
    ownership: "corp",
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    byteSize: bytes.byteLength,
    r2Key,
    sha256,
    source: "api_import",
    ingestChannel: "local-scanner-batch",
    actorMemberId: null,
  });

  return c.json({ ok: true, id }, 201);
});
