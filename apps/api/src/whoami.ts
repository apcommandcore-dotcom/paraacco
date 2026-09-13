// 身分驗證邏輯 —— 原本比照 paraentr 的 functions/api/whoami.js 直接信任
// Cf-Access-Authenticated-User-Email header,2026-09-06 改成驗證 Cf-Access-Jwt-Assertion
// 的簽章(見 access-jwt.ts 開頭註解說明原因跟已知限制)。不做密碼驗證——身分驗證交給
// Cloudflare Zero Trust Access 處理,這裡是驗證 Access 簽發的 JWT 是不是真的。
//
// 前提:這個 Worker 的自訂網域要落在既有的 `AP Internal Platform` Access Application
// (萬用字元 *.parallelserver.org)底下,Access 才會在邊緣先驗證、把 JWT 夾帶在
// Cf-Access-Jwt-Assertion 這個 header 裡送進來。
//
// 成員名單異動:改這個表,commit + push 即可,源頭以 paraentr 為準,這裡要跟著同步更新。

import { verifyAccessJwt } from "./access-jwt";

const TEAM: Record<string, string> = {
  "theosyl@icloud.com": "ShaoYi",
  "wu.plhojita@gmail.com": "PeiLing",
  // 系統/批次帳號(2026-09-14,見 access-jwt.ts 的 COMMON_NAME_ALLOWLIST)——不是真人,
  // 放在這裡只是讓 /api/whoami 這個診斷端點顯示有意義的名字,不影響權限判斷(權限看的是
  // middleware/auth.ts 查 members 表算出來的 scope,不是這裡)。
  "local-scanner-batch@service.paraacco.internal": "本地掃描批次系統",
};

export async function whoamiFromHeaders(headers: Headers) {
  const identity = await verifyAccessJwt(headers);
  const email = identity?.email ?? null;
  return {
    email,
    name: (email && TEAM[email]) || null,
  };
}
