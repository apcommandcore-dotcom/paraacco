// 收件匣上傳(規格 3.5.1)—— 2026-09-06 改成預簽 URL 直傳 R2(見
// CODE_TASK_post-golive-hardening_20260905.md 任務 2):瀏覽器直接 PUT 檔案到 R2,不再
// 先進 Worker 代傳——大檔案不會撞到 Worker 的 CPU/記憶體限制,Worker 只負責簽發 URL
// (POST /api/uploads/presign)跟事後建立 documents 記錄(POST /api/documents,沒變)。
//
// 預簽 URL 用 aws4fetch 簽 R2 的 S3 相容 API(見 bindings.ts 的 R2_ACCESS_KEY_ID/
// R2_SECRET_ACCESS_KEY/R2_ACCOUNT_ID 註解——這三個 secret 還沒設定的話這支端點會直接
// 500,不會靜默失敗)。
//
// POST /api/uploads(後端代傳,舊路徑)保留著當備援——如果之後遇到某些網路環境擋 R2
// 直連(見任務書提到的公司 VPN 之類情境,這個 session 沒有實際環境可以測,先留一條
// 逃生路線),前端可以切換回這條路徑,介面沒變(一樣回 r2Key/byteSize/sha256)。

import { Hono } from "hono";
import { AwsClient } from "aws4fetch";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";

export const uploadsRoute = new Hono<{ Bindings: Bindings }>();

const MAX_BYTES = 25 * 1024 * 1024; // 25MB,單據 PDF/照片綽綽有餘,避免濫用把 Worker 記憶體撐爆。
const BUCKET_NAME = "paraacco-files";
const PRESIGN_EXPIRES_SECONDS = 600; // 10 分鐘——單檔上傳綽綽有餘,過期時間拉太長沒有意義。

uploadsRoute.post("/presign", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{ fileName: string; mimeType?: string }>();
  if (!body.fileName) return c.json({ error: "missing fileName" }, 400);

  const safeName = body.fileName.replace(/[^\w.\-一-鿿]/g, "_") || "upload";
  const r2Key = `documents/uploads/${crypto.randomUUID()}/${safeName}`;

  const client = new AwsClient({
    accessKeyId: c.env.R2_ACCESS_KEY_ID,
    secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
  });

  // aws4fetch 沒有 expiresIn 這個方便選項——SigV4 預簽 URL 的有效期是靠 X-Amz-Expires
  // 這個 query string 參數本身控制,要在簽章「之前」就先放進 URL 裡,aws4fetch 才會把它
  // 一起算進簽章(看 aws4fetch 原始碼:signQuery 模式下,如果 URL 沒有帶
  // X-Amz-Expires,它會自動補一個預設值 86400 秒/24 小時——這裡明確帶自己的值蓋掉預設)。
  const url = new URL(`https://${c.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET_NAME}/${r2Key}`);
  url.searchParams.set("X-Amz-Expires", String(PRESIGN_EXPIRES_SECONDS));

  const signedRequest = await client.sign(
    new Request(url, {
      method: "PUT",
      headers: body.mimeType ? { "Content-Type": body.mimeType } : undefined,
    }),
    { aws: { signQuery: true } },
  );

  return c.json({ uploadUrl: signedRequest.url, r2Key, expiresIn: PRESIGN_EXPIRES_SECONDS });
});

// 舊路徑:後端代傳(multipart/form-data)。保留當備援,見檔案開頭註解。
uploadsRoute.post("/", async (c) => {
  const auth = c.get("auth");
  if (!canWrite(auth.scope)) return c.json({ error: "forbidden" }, 403);

  const form = await c.req.formData();
  const entry = form.get("file");
  // `File` 這個全域型別在 @cloudflare/workers-types 這裡沒有 merge 進全域命名空間
  // (只是模組內的 export),`instanceof`/直接標註型別都兜不起來,改用結構型別 duck-typing。
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

  return c.json({
    r2Key,
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    byteSize: bytes.byteLength,
    sha256,
  });
});
