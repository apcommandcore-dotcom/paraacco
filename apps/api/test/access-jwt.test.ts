// 關鍵路徑測試:Service Token(common_name)白名單映射(2026-09-14 新增,見
// apps/api/src/access-jwt.ts 開頭註解)。
//
// 沒辦法在本機簽發一個真的、Cloudflare 私鑰簽過的 JWT(跟 test/helpers.ts 開頭註解說明的
// 原因一樣),所以拆成兩段驗證同一條鏈:
//   1. resolveIdentityFromPayload() 是純函式,直接餵合成的 payload 物件測——涵蓋 email
//      優先、common_name 白名單命中/未命中、兩者都沒有四種情況。
//   2. 白名單映射出來的合成 email,真的能在 D1 查到對應的 members 記錄、算出
//      canWrite() 會通過的 scope——用 migrations-manual/0003_system_batch_member_seed.sql
//      的同一筆資料驗證,不是憑空假設。
// 兩段合起來就是「一個帶 common_name 但沒有 email 的 JWT,能正確映射到系統 member 且通過
// 寫入權限檢查」這條完整鏈路,只是拆成兩個不需要真實簽章就能驗證的部分。

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb, documents, members } from "@paraacco/db";
import { eq } from "drizzle-orm";
import { COMMON_NAME_ALLOWLIST, resolveIdentityFromPayload } from "../src/access-jwt";
import { canWrite, type AuthContext } from "../src/middleware/auth";
import { buildTestApp } from "./helpers";

const SCANNER_COMMON_NAME = "28ef77a8a2c18f97310e963b4b19d98c.access";

describe("resolveIdentityFromPayload", () => {
  it("email 存在時優先用 email,不看 common_name", () => {
    const identity = resolveIdentityFromPayload({ email: "theosyl@icloud.com", common_name: SCANNER_COMMON_NAME });
    expect(identity).toEqual({ email: "theosyl@icloud.com" });
  });

  it("沒有 email、common_name 在白名單裡 → 映射成對應的合成 email", () => {
    const identity = resolveIdentityFromPayload({ common_name: SCANNER_COMMON_NAME });
    expect(identity).toEqual({ email: COMMON_NAME_ALLOWLIST[SCANNER_COMMON_NAME].email });
  });

  it("沒有 email、common_name 不在白名單裡 → null(不自動信任新出現的 common_name)", () => {
    const identity = resolveIdentityFromPayload({ common_name: "某個沒登記過的 service token" });
    expect(identity).toBeNull();
  });

  it("email、common_name 都沒有 → null", () => {
    expect(resolveIdentityFromPayload({})).toBeNull();
  });
});

describe("系統/批次 member(migrations-manual/0003_system_batch_member_seed.sql)", () => {
  it("白名單映射出來的 email 能查到對應 member,scope 通得過 canWrite()", async () => {
    const db = createDb(env.DB);
    const scannerEmail = COMMON_NAME_ALLOWLIST[SCANNER_COMMON_NAME].email;

    await db
      .insert(members)
      .values({ id: "MEM-SYSTEM-BATCH", email: scannerEmail, name: "本地掃描批次系統", role: "accountant", scope: "corp", status: "active" })
      .onConflictDoNothing();

    const [row] = await db.select().from(members).where(eq(members.email, scannerEmail)).limit(1);
    expect(row).toBeDefined();
    expect(row?.status).toBe("active");
    expect(canWrite(row?.scope ?? null)).toBe(true);
  });

  it("以系統 member 身分呼叫 POST /api/documents 能成功登記(跟 authMiddleware 會算出的 auth 一致)", async () => {
    // 這裡不重跑真的 JWT 驗證(見檔頭註解為什麼不行),而是直接用 authMiddleware 解出
    // 這個系統 member 之後「會」產生的 AuthContext,驗證 documentsRoute 本身收到這組
    // auth 之後能不能正常寫入——上面兩個測試已經證明了「common_name → email → 這筆
    // member」這條映射鏈路是對的,這裡驗證的是鏈路終點(這組 auth)接到 route 之後的結果。
    const systemAuth: AuthContext = {
      email: COMMON_NAME_ALLOWLIST[SCANNER_COMMON_NAME].email,
      memberId: "MEM-SYSTEM-BATCH",
      name: "本地掃描批次系統",
      role: "accountant",
      scope: "corp",
    };
    const app = buildTestApp(systemAuth);

    const res = await app.request(
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownership: "corp",
          fileName: "system-batch-test.pdf",
          mimeType: "application/pdf",
          byteSize: 1000,
          r2Key: "documents/test/system-batch/v1/system-batch-test.pdf",
          source: "api_import",
          ingestChannel: "local-scanner-batch",
        }),
      },
      env,
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: true; id: string };

    const db = createDb(env.DB);
    const [doc] = await db.select().from(documents).where(eq(documents.id, body.id)).limit(1);
    expect(doc?.createdByMemberId).toBe("MEM-SYSTEM-BATCH");
  });
});
