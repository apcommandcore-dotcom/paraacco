"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Bell, ChevronDown, LogOut, Menu, Search, X } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { useScope } from "@/components/scope-context";
import { apiFetch, OWNERSHIP_LABELS, type CountsResponse, type NotificationItem, type OwnershipScope } from "@/lib/api";

// 2026-09-06 從頂部橫向選單改成側邊欄導覽,比照 Theo 提供的 VaultLink 設計稿
// (VaultLink.dc.html 的 <aside><nav> 結構,navGroups() 定義的清單)。2026-09-07 補完設計
// 落差任務書任務 1:購買案/資產補上獨立頂層導覽項目(底層沿用 /documents?view= 的既有邏輯,
// 只是換了路由跟導覽入口,見 app/purchases/page.tsx、app/assets/page.tsx)。保固與訂閱是
// 任務 3 的新畫面。管理後台任務 1 要求拆成 5 個獨立畫面,但這裡的導覽只留一個「管理」入口
// 進到 /admin(預設分類樹分頁),5 個子分頁的路由拆分見 app/admin/*/page.tsx,不在側邊欄
// 各自佔一個項目——側邊欄項目太多會失去「一眼看完」的可讀性,子分頁切換沿用 admin 頁面
// 自己的分頁列,這點跟設計稿的差異記錄在報告裡。
const NAV = [
  { href: "/inbox", label: "收件匣", en: "INBOX", countKey: "inbox" as const },
  { href: "/review", label: "待覆核", en: "REVIEW QUEUE", countKey: "pendingReview" as const },
  { href: "/purchases", label: "購買案", en: "PURCHASES" },
  { href: "/assets", label: "資產", en: "ASSETS" },
  { href: "/documents", label: "文件庫", en: "DOCUMENTS" },
  { href: "/warranty", label: "保固與訂閱", en: "COVERAGE" },
  { href: "/reconciliation", label: "對帳", en: "RECONCILIATION" },
  { href: "/dashboard", label: "總覽", en: "OVERVIEW" },
  { href: "/search", label: "搜尋", en: "SEARCH" },
  { href: "/reports", label: "報表", en: "REPORTS" },
];

const ADMIN_NAV = [{ href: "/admin", label: "管理後台", en: "ADMIN" }];

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

  function onSearch(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = new FormData(e.currentTarget).get("q");
    if (typeof q === "string" && q.trim()) router.push(`/search?q=${encodeURIComponent(q.trim())}`);
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background text-[14px] leading-relaxed">
      {/* 手機版側邊欄收合(2026-09-07 補完設計落差任務書任務 1)—— md 以下預設隱藏側邊欄,
          用左上角選單按鈕開合成覆蓋層;md 以上維持原本固定側邊欄,純 CSS breakpoint,沒有
          額外的 JS 斷點判斷邏輯。 */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[248px] flex-none flex-col overflow-hidden border-r border-border bg-nav transition-transform md:static md:z-auto md:translate-x-0 ${
          mobileNavOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-[72px] flex-none items-center justify-between gap-2.5 border-b border-border px-4">
          <Link href="/" className="flex items-center gap-2.5" onClick={() => setMobileNavOpen(false)}>
            <div className="h-5 w-5 flex-none bg-brand" />
            <span className="flex flex-col leading-tight">
              <span className="text-[15px] font-bold tracking-wide">Paraacco</span>
              <span className="font-mono text-[9px] tracking-[0.14em] text-foreground-3">ATELIER PARALLEL</span>
            </span>
          </Link>
          <button type="button" onClick={() => setMobileNavOpen(false)} className="text-foreground-3 md:hidden" aria-label="關閉導覽">
            <X size={16} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-1.5">
          <NavGroup items={NAV} pathname={pathname} onNavigate={() => setMobileNavOpen(false)} />
          <div className="mt-3 border-t border-line px-3 pb-2 pt-3.5 font-mono text-[10px] tracking-[0.12em] text-foreground-3">
            管理 ADMIN
          </div>
          <NavGroup items={ADMIN_NAV} pathname={pathname} onNavigate={() => setMobileNavOpen(false)} />
        </nav>

        <div className="flex flex-col border-t border-border">
          <ThemeToggle variant="row" />
        </div>
      </aside>

      {mobileNavOpen && <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setMobileNavOpen(false)} />}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-16 flex-none items-center gap-3 border-b border-border bg-surface px-4 md:px-5">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            className="flex-none text-foreground-3 md:hidden"
            aria-label="開啟導覽"
          >
            <Menu size={18} />
          </button>
          <form onSubmit={onSearch} className="relative min-w-0 max-w-[540px] flex-1">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground-3" />
            <input
              name="q"
              placeholder="搜尋發票號、訂單號、序號、品名、供應商或文件內容"
              className="h-[34px] w-full border border-line bg-muted pl-8 pr-3 text-[13px] text-foreground placeholder:text-foreground-3 focus-visible:border-border focus-visible:bg-surface focus-visible:outline-none"
            />
          </form>
          <div className="flex flex-none items-center gap-2">
            <ScopeSwitcher />
            <NotificationBell />
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto max-w-[1440px] px-6 py-6 md:px-7 md:py-7">{children}</div>
        </main>
      </div>
    </div>
  );
}

function NavGroup({
  items,
  pathname,
  onNavigate,
}: {
  items: { href: string; label: string; en: string; countKey?: "inbox" | "pendingReview" }[];
  pathname: string;
  onNavigate: () => void;
}) {
  const [counts, setCounts] = useState<CountsResponse | null>(null);

  useEffect(() => {
    if (!items.some((i) => i.countKey)) return;
    let cancelled = false;
    apiFetch<CountsResponse>("/api/counts")
      .then((data) => {
        if (!cancelled) setCounts(data);
      })
      .catch(() => {
        // 側邊欄數量徽章抓不到就不顯示,不影響導覽本身能不能用。
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        const count = item.countKey ? counts?.[item.countKey] : undefined;
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

// 範圍切換器(2026-09-07 補完設計落差任務書任務 2)—— 純前端 dropdown,狀態存在
// ScopeProvider(components/scope-context.tsx),換範圍不會自動重新整理頁面,個別畫面
// (dashboard/documents/inbox)自己 useScope() 讀目前範圍去打 API。
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
