import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;

// 讓 `next dev` 本機開發時也能存取 wrangler.jsonc 定義的 bindings(目前這個 app 還沒用到
// 任何 binding,先加上是照 OpenNext 官方 quickstart 慣例,之後如果要在 Server Component /
// Route Handler 裡讀 Cloudflare bindings 時就已經接好)。
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
