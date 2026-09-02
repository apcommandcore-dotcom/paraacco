// Cloudflare Workers bindings 型別 —— 對應 wrangler.toml 的 [[d1_databases]] / [[r2_buckets]]。

export type Bindings = {
  DB: D1Database;
  FILES: R2Bucket;
};
