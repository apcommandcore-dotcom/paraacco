CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`severity` text DEFAULT 'info' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`read_at` text,
	CONSTRAINT "notifications_type_check" CHECK("notifications"."type" IN ('weekly_review', 'monthly_review', 'inbox_stale', 'warranty_due', 'dup_candidate', 'pipeline_failed', 'transfer_submitted', 'transfer_decided')),
	CONSTRAINT "notifications_severity_check" CHECK("notifications"."severity" IN ('info', 'warning', 'critical'))
);
--> statement-breakpoint
CREATE INDEX `notifications_unread_idx` ON `notifications` (`read_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_type_entity_idx` ON `notifications` (`type`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `warranty_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`ownership` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`vendor_name` text,
	`start_date` text,
	`end_date` text NOT NULL,
	`renewal_cycle` text DEFAULT 'one_time' NOT NULL,
	`amount_cents` integer,
	`currency` text DEFAULT 'TWD',
	`reminder_days_before` integer DEFAULT 30 NOT NULL,
	`note` text,
	`created_by_member_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "warranty_subscriptions_entity_type_check" CHECK("warranty_subscriptions"."entity_type" IS NULL OR "warranty_subscriptions"."entity_type" IN ('asset')),
	CONSTRAINT "warranty_subscriptions_ownership_check" CHECK("warranty_subscriptions"."ownership" IN ('per', 'corp', 'advance', 'custody')),
	CONSTRAINT "warranty_subscriptions_type_check" CHECK("warranty_subscriptions"."type" IN ('warranty', 'subscription')),
	CONSTRAINT "warranty_subscriptions_renewal_check" CHECK("warranty_subscriptions"."renewal_cycle" IN ('one_time', 'monthly', 'quarterly', 'yearly')),
	CONSTRAINT "warranty_subscriptions_amount_check" CHECK("warranty_subscriptions"."amount_cents" IS NULL OR "warranty_subscriptions"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE INDEX `warranty_subscriptions_end_date_idx` ON `warranty_subscriptions` (`end_date`);--> statement-breakpoint
CREATE INDEX `warranty_subscriptions_ownership_idx` ON `warranty_subscriptions` (`ownership`);--> statement-breakpoint
CREATE INDEX `warranty_subscriptions_entity_idx` ON `warranty_subscriptions` (`entity_type`,`entity_id`);