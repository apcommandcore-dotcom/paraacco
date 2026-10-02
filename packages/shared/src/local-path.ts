// 原始檔只留 NAS(2026-09-28,CODE_TASK_local-originals-nas-path_20260927_V1.01.md)——
// document_files.storage='local' 時,檔案位置以 local_path(相對於 LOCAL_ROOT)記錄,不在 R2。
//
// LOCAL_ROOT 本身放在 apps/api/wrangler.toml 的 vars(smb://192.168.20.91/ATLPAR_Bookkeeper),
// 這裡只管「相對路徑長什麼樣子才合法」,API 與本機腳本共用同一份規則。

/** 系統受管區(只由腳本搬移、改名)。local_path 一律落在這底下。 */
export const MANAGED_ROOT = "Paraacco_公司財務系統";

/** 移出系統的資料(證券對帳單等,CODE_TASK V1.03)——文件標 ignored,但 local_path 仍記錄檔案去向。
 * 只有歸檔搬移(POST /api/archive/*)的目的地可以落在這裡;進件登記一律要在受管區內。 */
export const OUTSIDE_ROOT = "_系統外資料";

/** document_files.r2_key 仍是 NOT NULL + UNIQUE(放寬要重建表,D1 做不到),local 檔填這個前綴的佔位值。 */
export const LOCAL_R2_KEY_PREFIX = "local:";

export function localR2KeyPlaceholder(documentId: string, kind = "original"): string {
  return `${LOCAL_R2_KEY_PREFIX}${documentId}/${kind}`;
}

export function isLocalR2KeyPlaceholder(r2Key: string): boolean {
  return r2Key.startsWith(LOCAL_R2_KEY_PREFIX);
}

/**
 * 驗證 local_path:相對路徑、正斜線、在受管區內、不含 `.`/`..` 段落、沒有控制字元、長度合理。
 * 回傳錯誤訊息;合法時回傳 null。
 */
export function validateLocalPath(p: unknown, opts: { allowOutside?: boolean } = {}): string | null {
  if (typeof p !== "string" || !p) return "localPath 必須是非空字串";
  if (p.length > 512) return "localPath 太長(上限 512 字元)";
  if (p.startsWith("/") || /^[a-z]+:\/\//i.test(p)) return "localPath 必須是相對於 LOCAL_ROOT 的相對路徑";
  if (p.includes("\\")) return "localPath 一律用正斜線";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return "localPath 含控制字元";
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) return "localPath 不可有空段落、. 或 ..";
  const roots = opts.allowOutside ? [MANAGED_ROOT, OUTSIDE_ROOT] : [MANAGED_ROOT];
  if (!roots.includes(parts[0]) || parts.length < 3) return `localPath 必須位於 ${roots.join("/ 或 ")}/ 之下`;
  return null;
}

/** smb://host/share + 相對路徑 → 完整 NAS 路徑(每段 URL 編碼前的原樣字串,給人看/複製用)。 */
export function joinLocalRoot(localRoot: string, localPath: string): string {
  return `${localRoot.replace(/\/+$/, "")}/${localPath}`;
}
