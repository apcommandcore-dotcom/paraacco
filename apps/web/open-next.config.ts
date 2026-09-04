// OpenNext Cloudflare adapter 設定 —— 內部工具、低流量,先不開 R2 incremental cache
// (ISR/靜態頁面快取),避免多一個 R2 bucket 要管理。之後如果真的需要 ISR 快取,再照
// https://opennext.js.org/cloudflare/caching 補上 r2IncrementalCache。
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({});
