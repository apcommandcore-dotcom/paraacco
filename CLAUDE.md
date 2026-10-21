# CLAUDE.md(paraacco)

**最高原則在上層 `~/dev/CLAUDE.md`(版本留存、修正進版、執行完必回報 md 檔),本 repo 一律遵守。**

## 回報檔

- 位置:`~/dev/_reports/paraacco/CODE_REPORT_<主題>_<YYYYMMDD>.md`
- 最後一則訊息第一行寫出回報檔完整路徑。

## paraacco 專屬注意事項

- 任務檔與計畫檔在 `~/dev/_reports/paraacco/`(CODE_TASK_*、PLAN_*、SPEC_*)。開工前先讀最新版本號的那一份。
- 正式 D1 免費方案每日寫入上限 10 萬列(台灣時間 08:00 重置)。批次寫入要估算寫入量,超過就分天做。
- `apps/web` 部署前確認 API base 是 `https://acco-api.parallelserver.org`(`scripts/check-api-base.mjs`)。
- NAS 受管區 `Paraacco_公司財務系統` 內的檔案,只能由腳本搬移或改名,並且要同步回寫線上路徑。所有腳本先 dry-run 產生計畫檔,等 Theo 確認後才 `--apply`。
- drizzle-kit 產生的重建表 migration 有 INSERT...SELECT 的 bug(0007、0008 都遇過),一定要在有資料的本機 D1 驗證。
