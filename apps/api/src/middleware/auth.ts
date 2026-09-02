// 身分與權限 middleware —— 分兩層(見規格文件缺口清單第 3 點):
//   1. 「登入的人是誰」:Cloudflare Access 已經在邊緣驗證過,whoami.ts 只是把 header 讀出來。
//   2. 「這個人在 VaultLink 裡是什麼角色/範圍」:查 members 表(email 對應),掛在 c.get("auth")。
//
// scope 對應規格 2.12:
//   'personal_corp' 可看個人＋公司全部資料
//   'corp'          只能看公司歸屬(non-'per')的資料,可寫
//   'corp_readonly' 只能看公司歸屬的資料,唯讀(例:外部會計師)
//
// 找不到對應 members 資料列的人(email 有值但未建檔,或 Access 沒有夾帶 email)一律視為
// 沒有任何範圍權限(scope: null),所有寫入端點都會擋下來,只能看得到不需要驗證身分的端點。

import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { createDb, members } from "@paraacco/db";
import { whoamiFromHeaders } from "../whoami";
import type { Bindings } from "../bindings";

export type AuthContext = {
  email: string | null;
  memberId: string | null;
  name: string | null;
  role: string | null;
  scope: string | null;
};

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

export function authMiddleware(): MiddlewareHandler<{ Bindings: Bindings }> {
  return async (c, next) => {
    const who = whoamiFromHeaders(c.req.raw.headers);
    let auth: AuthContext = { email: who.email, memberId: null, name: who.name, role: null, scope: null };

    if (who.email) {
      const db = createDb(c.env.DB);
      const rows = await db.select().from(members).where(eq(members.email, who.email)).limit(1);
      const m = rows[0];
      if (m && m.status === "active") {
        auth = { email: m.email, memberId: m.id, name: m.name, role: m.role, scope: m.scope };
      }
    }

    c.set("auth", auth);
    await next();
  };
}

/** 依歸屬(ownership)判斷這個 scope 能不能看:'per' 只有 personal_corp 能看,其餘都算公司範圍。 */
export function canAccessOwnership(scope: string | null, ownership: string): boolean {
  if (!scope) return false;
  if (scope === "personal_corp") return true;
  if (ownership === "per") return false;
  return scope === "corp" || scope === "corp_readonly";
}

export function canWrite(scope: string | null): boolean {
  return !!scope && scope !== "corp_readonly";
}
