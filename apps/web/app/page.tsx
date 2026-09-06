"use client";

// 首頁 = 身分顯示 / 登入閘門,邏輯比照 parallelserver 既有慣例(paraentr 的
// public/apps/paraentr/index.html):不做自己的帳號密碼登入表單,身分驗證完全交給
// Cloudflare Zero Trust Access 處理 —— 只要這個網域(部署後)落在既有的
// `AP Internal Platform` Access Application(萬用字元 *.parallelserver.org)底下,
// Access 就會在使用者能看到這個頁面之前先擋一次登入畫面,這裡只是把 Access 驗證後夾帶的
// 身分(呼叫 apps/api 的 GET /api/whoami)讀出來顯示。
//
// 目前這個頁面在本機 `next dev` 或部署到還沒接上 *.parallelserver.org 網域的環境時,
// /api/whoami 不會有 Cf-Access-Authenticated-User-Email header,會顯示「未偵測到登入身分」
// ——這是預期行為,不是 bug,見 paraacco-integration/paraacco-deployment-report-20260903.md。
//
// API 網域(NEXT_PUBLIC_API_BASE_URL):apps/web 部署到 acco.parallelserver.org(見
// apps/web/wrangler.toml),apps/api 部署到 acco-api.parallelserver.org(見
// apps/api/wrangler.toml)——兩個都在 *.parallelserver.org 底下但不同子網域,所以還是跨網域
// 呼叫(apps/api 的 CORS allowlist 已經把 acco.parallelserver.org 列進去,見
// apps/api/src/index.ts 的 ALLOWED_WEB_ORIGINS)。本機開發可用 NEXT_PUBLIC_API_BASE_URL
// 覆寫成 http://localhost:8787 之類的本機 wrangler dev 網址。

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "https://acco-api.parallelserver.org";

type Whoami = { email: string | null; name: string | null };

// 登入後的導覽入口(2026-09-06 補上,見 CODE_TASK 首頁導覽任務)——跟 AppShell 頂部導覽列
// 用同一份清單,避免兩邊之後改一邊漏改一邊。
const NAV_LINKS = [
  { href: "/inbox", label: "收件匣" },
  { href: "/review", label: "待覆核" },
  { href: "/documents", label: "文件列表" },
  { href: "/dashboard", label: "總覽" },
  { href: "/reports", label: "報表" },
  { href: "/admin", label: "管理後台" },
];

export default function Home() {
  const [identity, setIdentity] = useState<Whoami | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/whoami`, { cache: "no-store", credentials: "include" })
      .then((r) => (r.ok ? (r.json() as Promise<Whoami>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (cancelled) return;
        setIdentity(data);
        setStatus("ok");
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const identityText =
    status === "loading"
      ? "確認登入身分中…"
      : status === "error"
        ? "無法連線到 paraacco-api"
        : identity?.name
          ? `已登入:${identity.name}`
          : identity?.email
            ? `已登入:${identity.email}`
            : "未偵測到登入身分";

  const loggedIn = status === "ok" && !!identity?.email;

  return (
    <AppShell>
      <Card>
        <CardContent className="p-7">
          <h1 className="m-0 text-xl font-bold tracking-wide">會計 — paraacco</h1>
          <div className="mt-2.5 font-mono text-xs text-foreground-3">{identityText}</div>
          <p className="mt-3 text-foreground-2">採購 / 資產 / 文件稽核型記帳平台。</p>
          {!loggedIn && status === "ok" && (
            <p className="mt-4 text-warning">
              沒有偵測到登入身分——如果你是透過 *.parallelserver.org 網域開啟這個頁面卻看到這行字,
              代表 Cloudflare Access 還沒套用到這個網域,需要檢查自訂網域是否已經掛在既有的
              「AP Internal Platform」Access Application 底下。
            </p>
          )}
          {status === "error" && (
            <p className="mt-4 text-destructive">
              呼叫 {API_BASE}/api/whoami 失敗——確認 paraacco-api 是否正常運作,或本機開發時是否
              需要調整 NEXT_PUBLIC_API_BASE_URL。
            </p>
          )}
          {loggedIn && (
            <div className="mt-6 border-t border-line-2 pt-5">
              <div className="mb-2.5 font-mono text-[11px] tracking-[0.12em] text-foreground-3">前往</div>
              <nav className="flex flex-wrap gap-x-6 gap-y-2.5">
                {NAV_LINKS.map((item) => (
                  <Link key={item.href} href={item.href} className="text-sm text-foreground underline">
                    {item.label}
                  </Link>
                ))}
              </nav>
            </div>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}
