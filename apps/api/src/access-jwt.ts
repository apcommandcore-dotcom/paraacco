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
//
// 2026-09-14 補上 Service Token(common_name)支援——每日批次進件排程腳本用 Access
// Service Token(不是真人登入)呼叫 API,這種 JWT 沒有 email claim,改用 common_name
// 識別身分。刻意用「明確白名單」(COMMON_NAME_ALLOWLIST)而不是「任何 common_name 都放行」
// ——email 那條路徑本來就有 members 表當一層防護(email 對不到任何 member 就是沒有權限),
// common_name 這條路徑沒有對應的表,不能省略這層檢查,否則等於任何拿得到合法簽章 JWT 的
// Service Token(就算不是我們自己建的)都能冒充身分。新增 Service Token 時要手動在這裡加
// 一條,不會自動信任新出現的 common_name。

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const TEAM_DOMAIN = "atelierparallel.cloudflareaccess.com";
const CERTS_URL = `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`;
const ACCESS_APP_AUD = "82d0652ecfc12a9438b2e9b2574ae72ad4a1e4ff3b137573cdd4a1289a0ace41";

// createRemoteJWKSet 內建快取(預設約 30 分鐘,依 jose 版本而定),不用自己再包一層快取。
const JWKS = createRemoteJWKSet(new URL(CERTS_URL));

export interface VerifiedAccessIdentity {
  email: string;
}

// common_name → 對應的合成 email,跟 packages/db 的 migrations-manual/
// 0003_system_batch_member_seed.sql 的 members.email 一致——這樣 whoami.ts/
// middleware/auth.ts 完全不用改,既有的「用 email 查 members 表」邏輯直接適用於這個
// 系統帳號,不需要另外開一條路徑。
//
// 28ef77a8a2c18f97310e963b4b19d98c.access:本地掃描批次排程(Theo 2026-09-14 建立的
// Access Service Token,範圍限定 acco-api.parallelserver.org/api/documents)。
export const COMMON_NAME_ALLOWLIST: Record<string, { email: string }> = {
  "28ef77a8a2c18f97310e963b4b19d98c.access": { email: "local-scanner-batch@service.paraacco.internal" },
};

/**
 * 從已驗證簽章的 JWT payload 算出身分——純函式,不碰網路/JWKS,方便單獨測試白名單映射邏輯
 * 對不對,不需要真的簽一個 Cloudflare 私鑰簽過的 JWT 才能測(見 test/access-jwt.test.ts)。
 */
export function resolveIdentityFromPayload(payload: JWTPayload): VerifiedAccessIdentity | null {
  if (typeof payload.email === "string" && payload.email) {
    return { email: payload.email };
  }
  if (typeof payload.common_name === "string") {
    const mapped = COMMON_NAME_ALLOWLIST[payload.common_name];
    if (mapped) return mapped;
  }
  return null;
}

/**
 * 驗證 Cf-Access-Jwt-Assertion header 帶的 JWT。驗證失敗(缺 header、簽章不對、過期、
 * issuer 不對)一律回傳 null,呼叫端要當作「沒有登入身分」處理,不能有任何 fallback
 * 去信任其他未驗證的來源。簽章驗證通過之後,身分本身怎麼從 payload 算出來(email 或
 * common_name 白名單)交給 resolveIdentityFromPayload()。
 */
export async function verifyAccessJwt(headers: Headers): Promise<VerifiedAccessIdentity | null> {
  const token = headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://${TEAM_DOMAIN}`,
      audience: ACCESS_APP_AUD,
    });
    return resolveIdentityFromPayload(payload);
  } catch {
    // 簽章不對、過期、issuer 不符都會丟到這裡——不要把細節回傳給呼叫端,一律當未登入。
    return null;
  }
}
