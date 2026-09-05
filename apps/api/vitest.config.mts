import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// 用 @cloudflare/vitest-plugin 在本機 Miniflare 環境跑測試(不連正式環境的 D1/R2/Queue,
// wrangler.toml 裡的資源 ID 只是拿來推斷 binding 型別用,見 test/setup.ts 開頭註解)。

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrationsPath = path.join(import.meta.dirname, "../../packages/db/migrations");
      const migrations = await readD1Migrations(migrationsPath);

      return {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
