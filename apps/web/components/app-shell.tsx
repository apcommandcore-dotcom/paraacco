"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

const NAV = [
  { href: "/inbox", label: "收件匣" },
  { href: "/review", label: "待覆核" },
  { href: "/documents", label: "文件" },
  { href: "/dashboard", label: "總覽" },
  { href: "/reports", label: "報表" },
  { href: "/admin", label: "管理" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();

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
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="flex flex-wrap items-center gap-8">
            <Link href="/" className="font-mono text-xs tracking-[0.18em] text-muted-foreground">
              ATELIER PARALLEL — PARAACCO
            </Link>
            <nav className="flex flex-wrap items-center gap-5">
              {NAV.map((item) => (
                <Link key={item.href} href={item.href} className="text-sm text-foreground hover:underline">
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <form onSubmit={onSearch} className="relative">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                name="q"
                placeholder="搜尋文件…"
                className="h-8 w-40 border border-input bg-background pl-7 pr-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </form>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
