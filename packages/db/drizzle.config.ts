import type { Config } from "drizzle-kit";

// 只用來產生 migration SQL(drizzle-kit generate),不連線到遠端 D1。
// 實際套用 migration 是用 wrangler d1 migrations apply,見 migrations/README.md。
export default {
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
} satisfies Config;
