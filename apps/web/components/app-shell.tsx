"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

// 2026-09-06 從頂部橫向選單改成側邊欄導覽,比照 Theo 提供的 VaultLink 設計稿
// (VaultLink.dc.html 的 <aside><nav> 結構,navGroups() 定義的清單)。設計稿裡的完整清單是
// 首頁/收件匣/待覆核/購買案/資產/文件庫/保固與訂閱/搜尋/報表,這裡只保留現有系統真的有對應
// 畫面的項目(購買案、資產、保固與訂閱目前沒有獨立畫面,不生連結——見
// CODE_REPORT_apply-design-system_20260906.md 的落差清單)。
const NAV = [
  { href: "/inbox", label: "收件匣", en: "INBOX" },
  { href: "/review", label: "待覆核", en: "REVIEW QUEUE" },
  { href: "/documents", label: "文件庫", en: "DOCUMENTS" },
  { href: "/dashboard", label: "總覽", en: "OVERVIEW" },
  { href: "/search", label: "搜尋", en: "SEARCH" },
  { href: "/reports", label: "報表", en: "REPORTS" },
];

const ADMIN_NAV = [{ href: "/admin", label: "管理後台", en: "ADMIN" }];

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  // 全域搜尋(規格 3.6)—— 導到 /search,接 GET /api/search,是 packages/db 已經實作好的
  // document FTS5 全文檢索(見 packages/db/src/search.ts 的 searchDocumentFts),涵蓋
  // 供應商名稱、發票/訂單/序號、OCR 擷取欄位的值、原始檔名,不是只篩選 documents 表的
  // 幾個直欄。
  function onSearch(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = new FormData(e.currentTarget).get("q");
    if (typeof q === "string" && q.trim()) router.push(`/search?q=${encodeURIComponent(q.trim())}`);
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background text-[14px] leading-relaxed">
      <aside className="flex w-[248px] flex-none flex-col overflow-hidden border-r border-border bg-nav">
        <div className="flex h-[72px] flex-none items-center gap-2.5 border-b border-border px-4">
          <div className="h-5 w-5 flex-none bg-brand" />
          <Link href="/" className="flex flex-col leading-tight">
            <span className="text-[15px] font-bold tracking-wide">Paraacco</span>
            <span className="font-mono text-[9px] tracking-[0.14em] text-foreground-3">ATELIER PARALLEL</span>
          </Link>
        </div>

        <nav className="flex-1 overflow-y-auto py-1.5">
          <NavGroup items={NAV} pathname={pathname} />
          <div className="mt-3 border-t border-line px-3 pb-2 pt-3.5 font-mono text-[10px] tracking-[0.12em] text-foreground-3">
            管理 ADMIN
          </div>
          <NavGroup items={ADMIN_NAV} pathname={pathname} />
        </nav>

        <div className="flex flex-col border-t border-border">
          <ThemeToggle variant="row" />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-16 flex-none items-center gap-3.5 border-b border-border bg-surface px-5">
          <form onSubmit={onSearch} className="relative max-w-[540px] flex-1">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground-3" />
            <input
              name="q"
              placeholder="搜尋發票號、訂單號、序號、品名、供應商或文件內容"
              className="h-[34px] w-full border border-line bg-muted pl-8 pr-3 text-[13px] text-foreground placeholder:text-foreground-3 focus-visible:border-border focus-visible:bg-surface focus-visible:outline-none"
            />
          </form>
        </header>
        <main className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto max-w-[1440px] px-6 py-6 md:px-7 md:py-7">{children}</div>
        </main>
      </div>
    </div>
  );
}

function NavGroup({ items, pathname }: { items: { href: string; label: string; en: string }[]; pathname: string }) {
  return (
    <div>
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex h-[50px] items-center gap-2.5 border-b border-line-2 px-4 text-[13.5px] no-underline ${
              active ? "bg-brand font-semibold text-on-brand" : "text-foreground hover:bg-nav-sub hover:text-foreground"
            }`}
          >
            <span className={`h-2 w-2 flex-none border ${active ? "border-on-brand bg-on-brand" : "border-line"}`} />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate">{item.label}</span>
              <span className={`block font-mono text-[8.5px] tracking-[0.11em] ${active ? "text-on-brand" : "text-foreground-3"}`}>
                {item.en}
              </span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}
