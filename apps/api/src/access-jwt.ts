// Cloudflare Access JWT 驗證(規格文件缺口清單第 3 點,2026-09-06 補上)。
//
// 背景:之前 whoami.ts 直接信任 Cf-Access-Authenticated-User-Email 這個 header,沒有驗證
// 任何簽章——這個 header 是 Cloudflare Access 驗證過身分後才會加上去的,理論上邊緣層會擋掉
// 客戶端自己偽造的版本,但這個保證只在請求真的有經過 Access 檢查點時成立。這個 Worker除了
// 自訂網域(在 Access 保護範圍內)以外,預設還會有一個 *.workers.dev 網址,那個網址不受
// Access 保護——如果 workers.dev 路由沒有明確關閉,任何人都能直接打那個網址、自己夾帶一個
// 偽造的 Cf-Access-Authenticated-User-Email header 冒充任何人(包含 admin)。
//
// 修正:改成驗證 Cloudflare Access 附上的 Cf-Access-Jwt-Assertion(一個 RS256 簽章的
// JWT),驗證方式照 Cloudflare 官方文件(https://developers.cloudflare.com/cloudflare-one/
// identity/authorization-cookie/validating-json/):
//   1. 從 Access 團隊的 JWKS 端點(https://<team>.cloudflareaccess.com/cdn-cgi/access/certs)
//      抓公鑰,用 `jose`(純 Web Crypto,Workers 相容,不用 Node API)驗證簽章。
//   2. 驗證 issuer(團隊網域)、過期時間(jose 的 jwtVerify 內建處理)。
//   3. email 一律從驗證過的 JWT payload 讀,不再相信任何 client 可控的 header。
//
// 已知還缺:沒有驗證 audience(aud,Access Application 的 AUD tag)——這個 tag 要在
// Cloudflare Zero Trust dashboard(Access → Applications →「AP Internal Platform」→
// Overview)才查得到,這次 wrangler 的 OAuth token 沒有 Access 相關的 API scope,沒辦法
// 用程式抓。先不驗證 aud 不影響核心安全性(能通過簽章驗證代表這個 JWT 一定是 Cloudflare
// Access 簽發的,不可能是偽造的),只是少了「這個 JWT 是不是簽給『這個』Access Application」
// 這一層額外檢查(同一個 Cloudflare 帳號底下如果有其他 Access Application,理論上那邊簽發的
// JWT 也會通過這裡的驗證)。等拿到 AUD tag,把 ACCESS_APP_AUD 這個常數填上、
// jwtVerify 的 options 加回 `audience: ACCESS_APP_AUD` 即可。

import { createRemoteJWKSet, jwtVerify } from "jose";

const TEAM_DOMAIN = "atelierparallel.cloudflareaccess.com";
const CERTS_URL = `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`;

// createRemoteJWKSet 內建快取(預設約 30 分鐘,依 jose 版本而定),不用自己再包一層快取。
const JWKS = createRemoteJWKSet(new URL(CERTS_URL));

export interface VerifiedAccessIdentity {
  email: string;
}

/**
 * 驗證 Cf-Access-Jwt-Assertion header 帶的 JWT。驗證失敗(缺 header、簽章不對、過期、
 * issuer 不對)一律回傳 null,呼叫端要當作「沒有登入身分」處理,不能有任何 fallback
 * 去信任其他未驗證的來源。
 */
export async function verifyAccessJwt(headers: Headers): Promise<VerifiedAccessIdentity | null> {
  const token = headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://${TEAM_DOMAIN}`,
    });
    if (typeof payload.email !== "string" || !payload.email) return null;
    return { email: payload.email };
  } catch {
    // 簽章不對、過期、issuer 不符都會丟到這裡——不要把細節回傳給呼叫端,一律當未登入。
    return null;
  }
}
