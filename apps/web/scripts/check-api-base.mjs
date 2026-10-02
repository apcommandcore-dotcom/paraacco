// 正式部署防呆(2026-09-28,CODE_TASK_local-originals-nas-path_20260927_V1.01.md 第〇節)——
// 2026-09-26 本機 `pnpm run deploy` 時 .env.local 的 NEXT_PUBLIC_API_BASE_URL=http://localhost:8787
// 被打包進正式版,正式站所有 API 呼叫都打到使用者自己電腦的 localhost。Next.js 在 production build
// 時 .env.local 的優先序高於 .env.production,所以光寫 .env.production 不夠,這裡兩段都檢查:
//   pre   build 前:依 Next.js 的讀取順序算出 production build 實際會用到的值,不是正式網址就中止。
//   post  build 後:掃 .open-next/assets 內所有 JS,出現 localhost / 127.0.0.1 就中止,不 deploy。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const EXPECTED = "https://acco-api.parallelserver.org";
const KEY = "NEXT_PUBLIC_API_BASE_URL";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const mode = process.argv[2];

function fail(msg) {
  console.error(`\n[check-api-base] 中止部署:${msg}\n`);
  process.exit(1);
}

function readEnvFile(file) {
  const p = path.join(root, file);
  if (!existsSync(p)) return undefined;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && m[1] === KEY) return m[2].replace(/^['"]|['"]$/g, "");
  }
  return undefined;
}

if (mode === "pre") {
  // Next.js production 讀取順序:process.env > .env.production.local > .env.local > .env.production > .env
  const sources = [
    ["環境變數", process.env[KEY]],
    [".env.production.local", readEnvFile(".env.production.local")],
    [".env.local", readEnvFile(".env.local")],
    [".env.production", readEnvFile(".env.production")],
    [".env", readEnvFile(".env")],
  ];
  const hit = sources.find(([, v]) => v !== undefined && v !== "");
  if (!hit) fail(`${KEY} 沒有設定(應為 ${EXPECTED})`);
  const [from, value] = hit;
  if (value.replace(/\/+$/, "") !== EXPECTED) fail(`${KEY}=${value}(來自 ${from}),正式部署必須是 ${EXPECTED}`);
  console.log(`[check-api-base] ${KEY}=${value}(來自 ${from})OK`);
} else if (mode === "post") {
  const dir = path.join(root, ".open-next", "assets");
  if (!existsSync(dir)) fail(`找不到 ${dir},build 沒有產出`);
  const bad = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".js") && /localhost:8787|127\.0\.0\.1:8787/.test(readFileSync(p, "utf8"))) bad.push(path.relative(root, p));
    }
  };
  walk(dir);
  if (bad.length) fail(`正式 bundle 內含 localhost API 網址:\n  ${bad.join("\n  ")}`);
  console.log("[check-api-base] .open-next/assets 不含 localhost:8787 OK");
} else {
  fail("用法:node scripts/check-api-base.mjs pre|post");
}
