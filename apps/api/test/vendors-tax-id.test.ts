// 2026-09-26「輸入統編直接新增供應商」:統編檢查碼、重複統編 409、查詢順序(公司 → 分公司 → 商號)。
// 經濟部 API 用注入的假 fetcher 測,不連外網。

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { vendorsRoute } from "../src/routes/vendors";
import { lookupTaxId } from "../src/tax-id-lookup";
import type { Bindings } from "../src/bindings";
import { TEST_AUTH } from "./helpers";

function buildApp() {
  const app = new Hono<{ Bindings: Bindings }>();
  app.use("*", async (c, next) => {
    c.set("auth", TEST_AUTH);
    await next();
  });
  app.route("/", vendorsRoute);
  return app;
}
const json = (app: Hono<{ Bindings: Bindings }>, path: string, body?: unknown) =>
  app.request(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}, env);

describe("供應商統編", () => {
  it("檢查碼錯誤回 400(新增與查詢都擋)", async () => {
    const app = buildApp();
    expect((await json(app, "/lookup/2897719")).status).toBe(400);
    expect((await json(app, "/", { name: "統康", taxId: "2897719" })).status).toBe(400);
  });

  it("有給名稱就直接新增,不查外部;同統編再新增回 409 並帶既有供應商", async () => {
    const app = buildApp();
    const res = await json(app, "/", { name: "統康生活事業股份有限公司 雨聲分公司", taxId: "28977199" });
    expect(res.status).toBe(201);
    const dup = await json(app, "/", { name: "家樂福", taxId: "2897 7199" });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { vendor: { name: string } }).vendor.name).toBe("統康生活事業股份有限公司 雨聲分公司");
  });

  it("查詢已登記的統編直接回既有供應商,不打外部 API", async () => {
    const app = buildApp();
    await json(app, "/", { name: "好市多股份有限公司 北投分公司", taxId: "24794037" });
    const res = await json(app, "/lookup/24794037");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ exists: true, vendor: { name: "好市多股份有限公司 北投分公司" } });
  });
});

describe("lookupTaxId 查詢順序", () => {
  function fakeFetcher(responses: Record<string, string>) {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const key = Object.keys(responses).find((k) => url.includes(k));
      return new Response(key ? responses[key] : "", { status: 200 });
    }) as typeof fetch;
    return { fetcher, calls };
  }

  it("公司登記查到就停,取 Company_Name / 狀態 / 地址", async () => {
    const { fetcher, calls } = fakeFetcher({
      "5F64D864": JSON.stringify([
        { Business_Accounting_NO: "83018456", Company_Name: "平行空間室內裝修有限公司", Company_Status_Desc: "核准設立", Responsible_Name: "呂劭翊", Company_Location: "桃園市" },
      ]),
    });
    const hit = await lookupTaxId("83018456", fetcher);
    expect(hit).toEqual({ taxId: "83018456", name: "平行空間室內裝修有限公司", status: "核准設立", address: "桃園市", source: "公司登記" });
    expect(calls).toHaveLength(1);
  });

  it("公司查無(空字串)→ 分公司;名稱欄位不排除負責人以外的 _Name", async () => {
    const { fetcher, calls } = fakeFetcher({
      FCB90AB1: JSON.stringify([{ Branch_Office_Name: "統康生活事業股份有限公司雨聲分公司", Branch_Office_Status_Desc: "核准設立" }]),
    });
    const hit = await lookupTaxId("28977199", fetcher);
    expect(hit?.name).toBe("統康生活事業股份有限公司雨聲分公司");
    expect(hit?.source).toBe("分公司登記");
    expect(calls).toHaveLength(2);
  });

  it("三個都查無回 null;單一來源錯誤不會中斷", async () => {
    const fetcher = (async (input: RequestInfo | URL) =>
      String(input).includes("5F64D864") ? new Response("oops", { status: 500 }) : new Response("", { status: 200 })) as typeof fetch;
    expect(await lookupTaxId("10458575", fetcher)).toBeNull();
  });
});
