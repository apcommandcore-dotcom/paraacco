"use client";

// 管理後台子導覽(2026-09-07 補完設計落差任務書任務 1)—— 比照 VaultLink 設計稿的管理分組
// (公司與成員/供應商與分類/自動化規則/歸屬移轉與稽核/系統設定),用真的路由取代原本的
// React state 分頁切換。「供應商與分類」合併了舊版的 vendors/categories 兩個分頁(設計稿
// 就是一個畫面),其餘 1:1 對應。
import Link from "next/link";
import { usePathname } from "next/navigation";

const ADMIN_TABS = [
  { href: "/admin/members", label: "公司與成員" },
  { href: "/admin/vendors", label: "供應商與分類" },
  { href: "/admin/rules", label: "自動化規則" },
  { href: "/admin/transfers", label: "歸屬移轉與稽核" },
  { href: "/admin/settings", label: "系統設定" },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <div className="mb-6 flex flex-wrap gap-2">
      {ADMIN_TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`border px-3 py-1.5 text-sm no-underline ${
            pathname === t.href ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-accent"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
