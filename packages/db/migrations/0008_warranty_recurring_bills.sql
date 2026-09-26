-- 2026-09-26 手動修正(同 0007 的 drizzle-kit 0.31.10 bug):原產出的 INSERT...SELECT 從舊表選取了尚不存在的
-- 新欄位(category/payment_method/account_ref),SQLite 會把不存在的雙引號識別字當字串常數,既有資料會被寫入
-- 'payment_method' 字面值並觸發 CHECK 失敗。改為只複製原有 17 欄,新欄位為 NULL。drizzle 原始產出保留於
-- _snapshots/0008_drizzle_raw/。snapshot.json 未改動。
-- warranty_subscriptions 沒有被其他表外鍵參照,DROP TABLE 不會踩到 D1 外鍵限制。
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_warranty_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`ownership` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`category` text,
	`vendor_name` text,
	`start_date` text,
	`end_date` text NOT NULL,
	`renewal_cycle` text DEFAULT 'one_time' NOT NULL,
	`amount_cents` integer,
	`payment_method` text,
	`account_ref` text,
	`currency` text DEFAULT 'TWD',
	`reminder_days_before` integer DEFAULT 30 NOT NULL,
	`note` text,
	`created_by_member_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "warranty_subscriptions_entity_type_check" CHECK("__new_warranty_subscriptions"."entity_type" IS NULL OR "__new_warranty_subscriptions"."entity_type" IN ('asset')),
	CONSTRAINT "warranty_subscriptions_ownership_check" CHECK("__new_warranty_subscriptions"."ownership" IN ('per', 'corp', 'advance', 'custody')),
	CONSTRAINT "warranty_subscriptions_type_check" CHECK("__new_warranty_subscriptions"."type" IN ('warranty', 'subscription', 'recurring_bill')),
	CONSTRAINT "warranty_subscriptions_renewal_check" CHECK("__new_warranty_subscriptions"."renewal_cycle" IN ('one_time', 'monthly', 'bimonthly', 'quarterly', 'semiannual', 'yearly')),
	CONSTRAINT "warranty_subscriptions_payment_method_check" CHECK("__new_warranty_subscriptions"."payment_method" IS NULL OR "__new_warranty_subscriptions"."payment_method" IN ('auto_debit', 'credit_card', 'manual')),
	CONSTRAINT "warranty_subscriptions_amount_check" CHECK("__new_warranty_subscriptions"."amount_cents" IS NULL OR "__new_warranty_subscriptions"."amount_cents" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_warranty_subscriptions`("id", "entity_type", "entity_id", "ownership", "name", "type", "vendor_name", "start_date", "end_date", "renewal_cycle", "amount_cents", "currency", "reminder_days_before", "note", "created_by_member_id", "created_at", "updated_at") SELECT "id", "entity_type", "entity_id", "ownership", "name", "type", "vendor_name", "start_date", "end_date", "renewal_cycle", "amount_cents", "currency", "reminder_days_before", "note", "created_by_member_id", "created_at", "updated_at" FROM `warranty_subscriptions`;--> statement-breakpoint
DROP TABLE `warranty_subscriptions`;--> statement-breakpoint
ALTER TABLE `__new_warranty_subscriptions` RENAME TO `warranty_subscriptions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `warranty_subscriptions_end_date_idx` ON `warranty_subscriptions` (`end_date`);--> statement-breakpoint
CREATE INDEX `warranty_subscriptions_ownership_idx` ON `warranty_subscriptions` (`ownership`);--> statement-breakpoint
CREATE INDEX `warranty_subscriptions_entity_idx` ON `warranty_subscriptions` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `warranty_subscriptions_type_idx` ON `warranty_subscriptions` (`type`);