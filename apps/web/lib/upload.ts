// 共用的文件上傳流程(2026-09-10 資產欄位對齊任務書任務 3)—— 收件匣、資產詳情「新增
// 說明書」共用同一套 presign → PUT → 登記邏輯,不要各自兜一份。原本這段程式碼只存在
// apps/web/app/inbox/page.tsx,這裡抽成共用模組,inbox 頁面改成呼叫這裡(行為不變)。
//
// 流程對應後端:POST /api/uploads/presign(簽 R2 直傳 URL)→ 瀏覽器直接 PUT 到 R2 →
// POST /api/documents(登記 documents + document_files,並丟進 DOCUMENT_QUEUE 跑 OCR
// pipeline——連說明書這種非財務單據也會跑一次 OCR,擷取結果通常空白或信心低,但不影響
// 資產關聯,不特別為它另開一條不跑 pipeline 的路徑)。

import { apiFetch } from "./api";

export function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return crypto.subtle.digest("SHA-256", bytes).then((digest) => [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""));
}

export function putWithProgress(url: string, file: File, contentType: string, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`R2 上傳失敗(HTTP ${xhr.status}）`)));
    xhr.onerror = () => reject(new Error("R2 上傳失敗(網路錯誤,檢查是否有防火牆/VPN 擋住 R2 直連)"));
    xhr.send(file);
  });
}

export async function uploadDocument(
  file: File,
  ownership: string,
  opts?: { source?: string; onProgress?: (pct: number) => void; onRegistering?: () => void },
): Promise<{ ok: true; id: string }> {
  const presign = await apiFetch<{ uploadUrl: string; r2Key: string }>("/api/uploads/presign", {
    method: "POST",
    body: JSON.stringify({ fileName: file.name, mimeType: file.type || "application/octet-stream" }),
  });

  await putWithProgress(presign.uploadUrl, file, file.type || "application/octet-stream", opts?.onProgress);

  opts?.onRegistering?.();

  const bytes = await file.arrayBuffer();
  const sha256 = await sha256Hex(bytes);

  return apiFetch<{ ok: true; id: string }>("/api/documents", {
    method: "POST",
    body: JSON.stringify({
      ownership,
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      byteSize: bytes.byteLength,
      r2Key: presign.r2Key,
      sha256,
      source: opts?.source ?? "web_upload",
    }),
  });
}
