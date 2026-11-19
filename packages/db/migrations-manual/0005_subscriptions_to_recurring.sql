-- 訂閱併入定期繳費 —— 2026-11-19
-- warranty_subscriptions(type='subscription')→ recurring_series(category='software')。
-- 原列保留唯讀(API 不再列出/修改/提醒),新列用 warranty_subscription_id 指回原列;重跑不會重複搬。
-- 只搬 renewal_cycle 為 monthly / yearly 的(recurring_series.cadence 只有這兩種對得上);其他週期請到 /recurring 手動新增。
-- 繳費期限規則:fixed_day,每期 due_day = 原到期日的「日」;needs_document=0(訂閱多半沒有紙本帳單,月份檢核不算缺)。
-- 原 vendor_name 是純文字(recurring_series 只有 vendor_id),寫進 note,搬完請到 /recurring 選供應商。
--
-- 試跑(先看會搬哪些):
--   npx wrangler d1 execute paraacco-db --remote --command "SELECT id, name, ownership, renewal_cycle, end_date, amount_cents FROM warranty_subscriptions WHERE type='subscription' AND renewal_cycle IN ('monthly','yearly') AND id NOT IN (SELECT warranty_subscription_id FROM recurring_series WHERE warranty_subscription_id IS NOT NULL)"
-- 套用:
--   npx wrangler d1 execute paraacco-db --remote --file=./migrations-manual/0005_subscriptions_to_recurring.sql

INSERT INTO recurring_series (
  id, name, ownership, cadence, start_month, end_month, warranty_subscription_id, note,
  category, amount_cents, payment_method, next_due_date, remind_days, needs_document,
  due_rule, due_day, amount_mode, require_proof
)
SELECT
  'RCS-' || printf('%03d', base.max_no + ROW_NUMBER() OVER (ORDER BY w.created_at, w.id)),
  w.name,
  w.ownership,
  w.renewal_cycle,
  substr(COALESCE(w.start_date, w.end_date), 1, 7),
  NULL,
  w.id,
  TRIM(COALESCE('供應商:' || w.vendor_name, '') || CASE WHEN w.note IS NOT NULL THEN char(10) || w.note ELSE '' END || char(10) || '(2026-11-19 由保固與訂閱 ' || w.id || ' 搬入)', char(10) || ' '),
  'software',
  w.amount_cents,
  w.payment_method,
  w.end_date,
  MIN(w.reminder_days_before, 30),
  0,
  'fixed_day',
  CAST(substr(w.end_date, 9, 2) AS INTEGER),
  CASE WHEN w.amount_cents IS NULL THEN 'variable' ELSE 'fixed' END,
  0
FROM warranty_subscriptions w
CROSS JOIN (
  SELECT COALESCE(MAX(CAST(substr(id, 5) AS INTEGER)), 0) AS max_no FROM recurring_series WHERE id GLOB 'RCS-[0-9]*'
) base
WHERE w.type = 'subscription'
  AND w.renewal_cycle IN ('monthly', 'yearly')
  AND w.id NOT IN (SELECT warranty_subscription_id FROM recurring_series WHERE warranty_subscription_id IS NOT NULL);

INSERT INTO activity_log (entity_type, entity_id, kind, text)
SELECT 'recurring_series', id, 'import', '訂閱併入定期繳費:由 ' || warranty_subscription_id || ' 搬入'
FROM recurring_series
WHERE category = 'software' AND warranty_subscription_id IN (SELECT id FROM warranty_subscriptions WHERE type = 'subscription')
  AND id NOT IN (SELECT entity_id FROM activity_log WHERE entity_type = 'recurring_series' AND text LIKE '訂閱併入定期繳費%');
