import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";

const NAV = [
  { href: "/inbox", label: "收件匣" },
  { href: "/review", label: "待覆核" },
  { href: "/documents", label: "文件" },
  { href: "/dashboard", label: "總覽" },
  { href: "/admin", label: "管理" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-8">
            <Link href="/" className="font-mono text-xs tracking-[0.18em] text-muted-foreground">
              ATELIER PARALLEL — PARAACCO
            </Link>
            <nav className="flex items-center gap-5">
              {NAV.map((item) => (
                <Link key={item.href} href={item.href} className="text-sm text-foreground hover:underline">
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
