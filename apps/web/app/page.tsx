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

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "https://acco-api.parallelserver.org";

type Whoami = { email: string | null; name: string | null };

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
    <main
      style={{
        minHeight: "100vh",
        background: "#F6F6F3",
        color: "#171717",
        fontFamily: "'Noto Sans TC', 'Helvetica Neue', sans-serif",
        fontSize: 15,
        lineHeight: 1.6,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header style={{ maxWidth: 1280, width: "100%", margin: "0 auto", padding: "48px 40px 0" }}>
        <div
          style={{
            borderTop: "1px solid #171717",
            paddingTop: 20,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            flexWrap: "wrap",
            gap: 16,
          }}
        >
          <div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, letterSpacing: "0.18em", color: "#8A8A85" }}>
              ATELIER PARALLEL — PARAACCO
            </div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: "#8A8A85", marginTop: 6 }}>
              {identityText}
            </div>
          </div>
        </div>
      </header>

      <div style={{ maxWidth: 1280, width: "100%", margin: "0 auto", padding: "32px 40px 64px", flex: 1 }}>
        <div style={{ border: "1px solid #171717", background: "#FFFFFF", padding: 28 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "0.04em" }}>會計 — paraacco</h1>
          <p style={{ margin: "12px 0 0", color: "#525250" }}>
            採購 / 資產 / 文件稽核型記帳平台。畫面尚未實作(收件匣、待覆核工作台、報表等,見規格
            文件),目前這個首頁只負責顯示登入身分,確認 Cloudflare Access 閘門(比照 paraentr)
            接得起來。
          </p>
          {!loggedIn && status === "ok" && (
            <p style={{ margin: "16px 0 0", color: "#A97824" }}>
              沒有偵測到登入身分——如果你是透過 *.parallelserver.org 網域開啟這個頁面卻看到這行字,
              代表 Cloudflare Access 還沒套用到這個網域,需要檢查自訂網域是否已經掛在既有的
              「AP Internal Platform」Access Application 底下。
            </p>
          )}
          {status === "error" && (
            <p style={{ margin: "16px 0 0", color: "#B2473E" }}>
              呼叫 {API_BASE}/api/whoami 失敗——確認 paraacco-api 是否正常運作,或本機開發時是否
              需要調整 NEXT_PUBLIC_API_BASE_URL。
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
