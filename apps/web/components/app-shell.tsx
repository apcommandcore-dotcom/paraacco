"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Bell, ChevronDown, FileBarChart, LogOut, Menu, MoreHorizontal, Plus, Search, X } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { useScope } from "@/components/scope-context";
import { apiFetch, OWNERSHIP_LABELS, type CountsResponse, type NotificationItem, type OwnershipScope } from "@/lib/api";

// 2026-09-18 從左側側邊欄改成頂部橫向 3 分頁導覽,比照 Theo 提供的
// 「paraacco copy-對齊後台copy.dc.html」design 檔案(總覽/清單/處理中心)。這是 Theo 明確
// 選的「完整照 design 改成 3 分頁」方案(見 DESIGN_REVIEW_paraacco-design-v8-verification_
// 20260916.md),取代 2026-09-06 建立的側邊欄版本。
//
// design 這份 3 分頁的頂層導覽本身沒有列出「依標題瀏覽／對帳／保固與訂閱／管理後台」四個
// 項目——但這幾個畫面(尤其依標題瀏覽、對帳)是這個 session 才剛做完、Theo 實際確認能動的
// 功能,不能因為新 IA 沒畫出來就悄悄拿掉。做法:這四項收進右上角「更多」選單(MORE_LINKS),
// 不放進主要 3 分頁,但保留一鍵可達——「搜尋」則對應 design 頂欄中央那個指令列風格搜尋框
// (⌘K 提示,沿用原本就有的 onSearch 邏輯,不是新元件),「報表」對應右上角 design 標出的
// 報表按鈕。舊路由(/purchases /assets /browse /warranty /reconciliation /admin /review
// /search)全部原封不動,只是拿掉了在側邊欄各自佔一格的入口。
const TABS = [
  { href: "/dashboard", label: "總覽", en: "OVERVIEW" },
  { href: "/documents", label: "清單", en: "LIST" },
  { href: "/inbox", label: "處理中心", en: "PROCESS", countKey: "process" as const },
];

const MORE_LINKS = [
  { href: "/browse", label: "依標題瀏覽", en: "BROWSE" },
  { href: "/warranty", label: "保固與訂閱", en: "COVERAGE" },
  { href: "/reconciliation", label: "對帳", en: "RECONCILIATION" },
  { href: "/admin", label: "管理後台", en: "ADMIN" },
];

const SCOPE_OPTIONS: { value: OwnershipScope | null; label: string }[] = [
  { value: null, label: "全部" },
  { value: "corp", label: OWNERSHIP_LABELS.corp },
  { value: "per", label: OWNERSHIP_LABELS.per },
  { value: "advance", label: OWNERSHIP_LABELS.advance },
  { value: "custody", label: OWNERSHIP_LABELS.custody },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [counts, setCounts] = useState<CountsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<CountsResponse>("/api/counts")
      .then((data) => {
        if (!cancelled) setCounts(data);
      })
      .catch(() => {
        // 分頁數量徽章抓不到就不顯示,不影響導覽本身能不能用。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function onSearch(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = new FormData(e.currentTarget).get("q");
    if (typeof q === "string" && q.trim()) router.push(`/search?q=${encodeURIComponent(q.trim())}`);
  }

  const processCount = counts ? counts.inbox + counts.pendingReview : undefined;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-[14px] leading-relaxed">
      <header className="flex h-16 flex-none items-center gap-3 border-b border-border bg-nav px-4 md:px-5">
        <Link href="/dashboard" className="flex flex-none items-center gap-2.5" onClick={() => setMobileNavOpen(false)}>
          <div className="h-5 w-5 flex-none bg-brand" />
          <span className="hidden flex-col leading-tight sm:flex">
            <span className="text-[15px] font-bold tracking-wide">Paraacco</span>
            <span className="font-mono text-[9px] tracking-[0.14em] text-foreground-3">ATELIER PARALLEL</span>
          </span>
        </Link>

        <nav className="hidden flex-none items-center gap-1 md:flex">
          {TABS.map((tab) => {
            const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
            const count = tab.countKey === "process" ? processCount : undefined;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={`flex h-9 items-center gap-1.5 border px-3 text-[13.5px] font-semibold no-underline ${
                  active
                    ? "border-brand bg-brand text-on-brand"
                    : "border-transparent text-foreground-2 hover:border-line hover:bg-nav-sub"
                }`}
              >
                {tab.label}
                {!!count && (
                  <span
                    className={`min-w-[18px] rounded-none px-1 text-center font-mono text-[10px] font-semibold ${
                      active ? "bg-on-brand text-brand" : "bg-destructive text-white"
                    }`}
                  >
                    {count}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <button
          type="button"
          onClick={() => setMobileNavOpen(true)}
          className="flex-none text-foreground-3 md:hidden"
          aria-label="開啟導覽"
        >
          <Menu size={18} />
        </button>

        <form onSubmit={onSearch} className="relative min-w-0 max-w-[440px] flex-1">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground-3" />
          <input
            name="q"
            placeholder="搜尋發票號、訂單號、序號、品名、供應商或文件內容"
            className="h-[34px] w-full border border-line bg-muted pl-8 pr-3 text-[13px] text-foreground placeholder:text-foreground-3 focus-visible:border-border focus-visible:bg-surface focus-visible:outline-none"
          />
        </form>

        <div className="flex flex-none items-center gap-2">
          <ScopeSwitcher />
          <Link
            href="/inbox"
            className="hidden h-[34px] items-center gap-1.5 border border-transparent bg-brand px-3 text-xs font-semibold text-on-brand no-underline hover:bg-brand-hover lg:flex"
          >
            <Plus size={13} />
            快速上傳
          </Link>
          <Link
            href="/reports"
            className="hidden h-[34px] items-center gap-1.5 border border-line bg-surface px-2.5 text-xs text-foreground hover:border-border lg:flex"
          >
            <FileBarChart size={13} />
            報表
          </Link>
          <MoreMenu pathname={pathname} />
          <NotificationBell />
          <UserMenu />
        </div>
      </header>

      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-surface md:hidden">
          <div className="flex h-16 flex-none items-center justify-between border-b border-border px-4">
            <span className="text-[15px] font-bold tracking-wide">Paraacco</span>
            <button type="button" onClick={() => setMobileNavOpen(false)} className="text-foreground-3" aria-label="關閉導覽">
              <X size={18} />
            </button>
          </div>
          <nav className="flex-1 overflow-y-auto py-1.5">
            <MobileNavGroup items={TABS} pathname={pathname} onNavigate={() => setMobileNavOpen(false)} counts={{ process: processCount }} />
            <div className="mt-3 border-t border-line px-4 pb-2 pt-3.5 font-mono text-[10px] tracking-[0.12em] text-foreground-3">
              更多 MORE
            </div>
            <MobileNavGroup
              items={[...MORE_LINKS, { href: "/reports", label: "報表", en: "REPORTS" }, { href: "/search", label: "搜尋", en: "SEARCH" }]}
              pathname={pathname}
              onNavigate={() => setMobileNavOpen(false)}
            />
          </nav>
        </div>
      )}

      <main className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto max-w-[1440px] px-6 py-6 md:px-7 md:py-7">{children}</div>
      </main>
    </div>
  );
}

function MobileNavGroup({
  items,
  pathname,
  onNavigate,
  counts,
}: {
  items: { href: string; label: string; en: string }[];
  pathname: string;
  onNavigate: () => void;
  counts?: Record<string, number | undefined>;
}) {
  return (
    <div>
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        const count = counts?.[item.href.replace("/", "")] ?? (item.href === "/inbox" ? counts?.process : undefined);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
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
            {!!count && (
              <span
                className={`min-w-[20px] rounded-none px-1.5 py-0.5 text-center font-mono text-[10.5px] font-semibold ${
                  active ? "bg-on-brand text-brand" : "bg-destructive text-white"
                }`}
              >
                {count}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

// 「更多」選單(2026-09-18)—— 收納這輪 design 3 分頁頂層導覽沒畫出來、但 Theo 之前確認
// 要保留的四個既有功能入口,見檔案開頭註解。
function MoreMenu({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);
  const active = MORE_LINKS.some((l) => pathname === l.href || pathname.startsWith(`${l.href}/`));

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex h-[34px] w-[34px] items-center justify-center border text-foreground-2 hover:border-border ${
          active ? "border-brand bg-brand-soft text-brand" : "border-line bg-surface"
        }`}
        aria-label="更多功能"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-[38px] z-40 w-52 border border-border bg-surface">
            {MORE_LINKS.map((item) => {
              const itemActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className={`flex items-center justify-between border-b border-line-2 px-3.5 py-2.5 text-xs no-underline last:border-0 hover:bg-nav-sub ${
                    itemActive ? "font-semibold text-brand" : "text-foreground"
                  }`}
                >
                  <span>{item.label}</span>
                  <span className="font-mono text-[9px] tracking-[0.1em] text-foreground-3">{item.en}</span>
                </Link>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// 範圍切換器(2026-09-07 補完設計落差任務書任務 2,2026-09-18 從側邊欄 header 搬到頂欄,
// 邏輯不變)—— 純前端 dropdown,狀態存在 ScopeProvider(components/scope-context.tsx),
// 換範圍不會自動重新整理頁面,個別畫面(dashboard/documents/inbox)自己 useScope() 讀目前
// 範圍去打 API。
function ScopeSwitcher() {
  const { scope, setScope } = useScope();
  const [open, setOpen] = useState(false);
  const current = SCOPE_OPTIONS.find((o) => o.value === scope) ?? SCOPE_OPTIONS[0];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-[34px] items-center gap-1.5 border border-line bg-surface px-2.5 text-xs text-foreground hover:border-border"
      >
        <span>{current.label}</span>
        <ChevronDown size={12} className="text-foreground-3" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-[38px] z-40 w-32 border border-border bg-surface">
            {SCOPE_OPTIONS.map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => {
                  setScope(opt.value);
                  setOpen(false);
                }}
                className={`block w-full border-b border-line-2 px-3 py-2 text-left text-xs last:border-0 hover:bg-nav-sub ${
                  opt.value === scope ? "font-semibold text-brand" : "text-foreground"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// 通知中心(2026-09-07 補完設計落差任務書任務 5)—— 下拉列表 + 已讀/未讀 + 全部標記已讀。
function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);

  async function load() {
    try {
      const data = await apiFetch<{ notifications: NotificationItem[]; unreadCount: number }>("/api/notifications");
      setItems(data.notifications);
      setUnreadCount(data.unreadCount);
    } catch {
      // 通知抓不到就顯示空清單,不影響其他功能。
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function markRead(id: number) {
    setItems((prev) => prev?.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)) ?? null);
    setUnreadCount((c) => Math.max(0, c - 1));
    await apiFetch(`/api/notifications/${id}/read`, { method: "POST" }).catch(() => {});
  }

  async function markAllRead() {
    setItems((prev) => prev?.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })) ?? null);
    setUnreadCount(0);
    await apiFetch("/api/notifications/read-all", { method: "POST" }).catch(() => {});
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          if (!open) load();
        }}
        className="relative flex h-[34px] w-[34px] items-center justify-center border border-line bg-surface text-foreground-2 hover:border-border"
        aria-label="通知中心"
      >
        <Bell size={14} />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 min-w-[15px] rounded-none bg-destructive px-1 text-center font-mono text-[9.5px] leading-[15px] text-white">
            {unreadCount}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-[38px] z-40 max-h-[420px] w-[336px] overflow-y-auto border border-border bg-surface">
            <div className="flex items-center justify-between border-b border-line-2 px-3.5 py-3">
              <span className="text-[13px] font-bold">通知中心</span>
              <button type="button" onClick={markAllRead} className="text-xs text-brand hover:underline">
                全部標記已讀
              </button>
            </div>
            {items === null && <div className="p-4 text-xs text-foreground-3">載入中…</div>}
            {items?.length === 0 && <div className="p-4 text-xs text-foreground-3">目前沒有通知。</div>}
            {items?.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => markRead(n.id)}
                className="flex w-full items-start gap-2.5 border-b border-line-2 px-3.5 py-2.5 text-left last:border-0 hover:bg-nav-sub"
              >
                <span
                  className={`mt-1.5 h-1.5 w-1.5 flex-none ${
                    n.readAt ? "bg-transparent" : n.severity === "critical" ? "bg-destructive" : n.severity === "warning" ? "bg-warning" : "bg-info"
                  }`}
                />
                <span className="min-w-0">
                  <span className={`block text-[12.5px] ${n.readAt ? "text-foreground-2" : "font-medium text-foreground"}`}>{n.title}</span>
                  <span className="block text-[11.5px] text-foreground-2">{n.message}</span>
                  <span className="mt-0.5 block text-[10.5px] text-foreground-3">{new Date(n.createdAt).toLocaleString("zh-TW")}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// 使用者頭像下拉選單(2026-09-07 補完設計落差任務書任務 1)—— 沿用首頁既有的 whoami 邏輯,
// 沒有另外做一套身分抓取。登出走 Cloudflare Access 的標準登出路徑(/cdn-cgi/access/logout,
// 掛在任何受保護的網域上都能觸發,清掉整個 team 的登入 session),不是這個系統自己的邏輯。
function UserMenu() {
  const [open, setOpen] = useState(false);
  const [identity, setIdentity] = useState<{ email: string | null; name: string | null } | null>(null);

  useEffect(() => {
    apiFetch<{ email: string | null; name: string | null }>("/api/whoami")
      .then(setIdentity)
      .catch(() => {});
  }, []);

  const displayName = identity?.name ?? identity?.email ?? "未登入";
  const initial = displayName.slice(0, 1).toUpperCase();

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-[34px] items-center gap-1.5 border border-line bg-surface pl-1 pr-2 hover:border-border"
      >
        <span className="flex h-[26px] w-[26px] items-center justify-center bg-brand font-mono text-[11px] font-bold text-on-brand">
          {initial}
        </span>
        <ChevronDown size={12} className="hidden text-foreground-3 sm:block" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-[38px] z-40 w-56 border border-border bg-surface">
            <div className="border-b border-line-2 px-3.5 py-3">
              <div className="text-[13px] font-semibold">{displayName}</div>
              {identity?.email && identity.name && <div className="text-[11px] text-foreground-3">{identity.email}</div>}
            </div>
            <a
              href="/cdn-cgi/access/logout"
              className="flex items-center gap-2 px-3.5 py-2.5 text-xs text-foreground no-underline hover:bg-nav-sub"
            >
              <LogOut size={13} />
              登出
            </a>
          </div>
        </>
      )}
    </div>
  );
}

// ADMIN_NAV 舊有側邊欄用不到了(管理後台入口移到 MoreMenu),app/admin/* 各頁面自己的
// AdminNav(components/admin-nav.tsx)子導覽不受影響,照舊。
