"use client";

// 原始檔位置(2026-09-28,CODE_TASK_local-originals-nas-path_20260927_V1.01.md 第六節 2)——
// storage='local' 的文件原始檔只留 NAS,網頁不再串流檔案,改顯示 NAS 完整路徑讓使用者自己開。
// smb:// 連結很多瀏覽器會擋,所以以「複製」為主;另外附 macOS Finder 掛載後的 /Volumes 路徑。
// 2026-11-19:路徑本身改成可點——連到 paraacco-open://open/<share>/<相對路徑>,由 Mac 上的
// ParaaccoOpen.app(scripts/paraacco-open/)接手:必要時掛載 NAS,再用 Chrome 開啟 PDF。

import { useState } from "react";
import { Check, Copy, FolderOpen } from "lucide-react";
import type { DocumentFile } from "@/lib/api";

const DEFAULT_LOCAL_ROOT = "smb://192.168.20.91/ATLPAR_Bookkeeper";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** smb://host/share/a/b → /Volumes/share/a/b(macOS 用 Finder 掛載後的預設路徑)。 */
function toVolumesPath(fullPath: string): string | null {
  const m = /^smb:\/\/[^/]+\/(.+)$/.exec(fullPath);
  return m ? `/Volumes/${m[1]}` : null;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => window.prompt("複製這個路徑", text));
      }}
      className="inline-flex h-7 flex-none items-center gap-1 border border-line bg-surface px-2 text-xs text-foreground hover:border-border"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? "已複製" : label}
    </button>
  );
}

/** smb://host/share/a/b → paraacco-open://open/share/a/b(每段 URL 編碼),給 ParaaccoOpen.app 接手。 */
function toOpenHref(fullPath: string): string | null {
  const m = /^smb:\/\/[^/]+\/(.+)$/.exec(fullPath);
  if (!m) return null;
  return `paraacco-open://open/${m[1].split("/").map(encodeURIComponent).join("/")}`;
}

export function NasLocation({ file, localRoot }: { file: DocumentFile; localRoot?: string }) {
  if (!file.localPath) return null;
  const root = (localRoot ?? DEFAULT_LOCAL_ROOT).replace(/\/+$/, "");
  const fullPath = `${root}/${file.localPath}`;
  const volumesPath = toVolumesPath(fullPath);
  const smbHref = `${root}/${file.localPath.split("/").map(encodeURIComponent).join("/")}`;
  const fileName = file.localPath.split("/").pop() ?? file.originalFileName;
  const openHref = toOpenHref(fullPath);

  return (
    <section className="border border-border bg-muted p-3 text-xs">
      <div className="mb-2 flex items-center gap-1.5 font-semibold text-foreground">
        <FolderOpen size={13} />
        原始檔位置(NAS)
      </div>
      <div className="flex items-start gap-2">
        {openHref ? (
          <a
            href={openHref}
            title="用 Chrome 開啟 PDF(需安裝 ParaaccoOpen.app)"
            className="min-w-0 flex-1 break-all font-mono text-[11.5px] text-primary hover:underline"
          >
            {fullPath}
          </a>
        ) : (
          <code className="min-w-0 flex-1 break-all font-mono text-[11.5px] text-foreground">{fullPath}</code>
        )}
        <CopyButton text={fullPath} label="複製" />
      </div>
      {volumesPath && (
        <div className="mt-1.5 flex items-start gap-2 text-muted-foreground">
          <code className="min-w-0 flex-1 break-all font-mono text-[11.5px]">{volumesPath}</code>
          <CopyButton text={volumesPath} label="複製 Mac 路徑" />
        </div>
      )}
      <dl className="mt-2.5 grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 text-muted-foreground">
        <dt>檔名</dt>
        <dd className="break-all text-foreground">{fileName}</dd>
        {fileName !== file.originalFileName && (
          <>
            <dt>進件檔名</dt>
            <dd className="break-all">{file.originalFileName}</dd>
          </>
        )}
        <dt>大小</dt>
        <dd>{formatBytes(file.byteSize)}</dd>
        {file.sha256 && (
          <>
            <dt>SHA-256</dt>
            <dd className="break-all font-mono text-[11px]">{file.sha256}</dd>
          </>
        )}
      </dl>
      <div className="mt-2 text-muted-foreground">
        {openHref && (
          <a href={openHref} className="mr-3 font-semibold text-primary hover:underline">
            在 Chrome 開啟 PDF
          </a>
        )}
        <a href={smbHref} className="text-primary hover:underline">
          用 smb:// 開啟(Finder)
        </a>
      </div>
    </section>
  );
}
