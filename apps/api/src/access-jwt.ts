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
// 2026-09-06 補上 audience(aud)驗證——AUD tag 由 Theo 從 Zero Trust dashboard
// (Access → Applications →「AP Internal Platform」→ Overview)提供。沒有這一層檢查時,
// 同一個 Cloudflare 帳號底下任何其他 Access Application 簽發的合法 JWT 理論上都能通過
// 這裡的驗證(因為都是同一個 team 的 JWKS 簽的、issuer 也相同)——加上 aud 比對後,只有
// 簽給「這個」Access Application 的 JWT 才會通過。

import { createRemoteJWKSet, jwtVerify } from "jose";

const TEAM_DOMAIN = "atelierparallel.cloudflareaccess.com";
const CERTS_URL = `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`;
const ACCESS_APP_AUD = "82d0652ecfc12a9438b2e9b2574ae72ad4a1e4ff3b137573cdd4a1289a0ace41";

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
      audience: ACCESS_APP_AUD,
    });
    if (typeof payload.email !== "string" || !payload.email) return null;
    return { email: payload.email };
  } catch {
    // 簽章不對、過期、issuer 不符都會丟到這裡——不要把細節回傳給呼叫端,一律當未登入。
    return null;
  }
}
