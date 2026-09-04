// 收件匣上傳(規格 3.5.1)—— 瀏覽器端把檔案原始位元組直接 POST 過來,這裡代傳到 R2,回傳
// r2Key/byteSize/sha256 給前端接著呼叫 POST /api/documents 登記文件(見 documents.ts 開頭
// 說明的架構邊界:這支路由一樣只給人類使用者用,走 Cloudflare Access)。
//
// 先求能動:用後端代傳(multipart/form-data,單一 request 直接吃檔案位元組),不是預簽 URL
// 直傳 R2——避免在 Workers 裡手刻 R2 presigned URL 簽章邏輯,檔案量體(單據 PDF/照片)不大,
// 代傳的額外流量成本可忽略。之後如果真的要換成預簽 URL 直傳,只需要新增一個端點簽發
// URL,不用動 POST /api/documents 這邊的介面(還是吃 r2Key)。

import { Hono } from "hono";
import type { Bindings } from "../bindings";
import { canWrite } from "../middleware/auth";

export const uploadsRoute = new Hono<{ Bindings: Bindings }>();

const MAX_BYTES = 25 * 1024 * 1024; // 25MB,單據 PDF/照片綽綽有餘,避免濫用把 Worker 記憶體撐爆。

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
