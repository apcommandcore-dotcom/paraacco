// apps/api 的 /internal/* 端點呼叫封裝 —— 透過 Service Binding(env.API)直接呼叫,不經過
// 公開網域,也不經過 Cloudflare Access,改用共用密鑰驗證(見 apps/api 的
// middleware/internal-auth.ts)。
//
// Service Binding 的 fetch 不需要真的能解析主機名稱,URL 只是拿來組 Hono 的路由比對用,
// 這裡固定用一個佔位主機名。

import type { Bindings } from "./bindings";

export class InternalApiError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`internal API ${path} failed: ${status} ${body}`);
  }
}

export async function callInternal<T = unknown>(
  env: Bindings,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await env.API.fetch(`https://internal.paraacco.local${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": env.INTERNAL_SERVICE_TOKEN,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new InternalApiError(path, res.status, text);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}
