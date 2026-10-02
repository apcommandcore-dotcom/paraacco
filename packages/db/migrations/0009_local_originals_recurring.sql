CREATE TABLE `recurring_month_marks` (
	`series_id` text NOT NULL,
	`month` text NOT NULL,
	`status` text NOT NULL,
	`note` text,
	`created_by_member_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`series_id`, `month`),
	FOREIGN KEY (`series_id`) REFERENCES `recurring_series`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recurring_month_marks_status_check" CHECK("recurring_month_marks"."status" IN ('not_required', 'encrypted'))
);
--> statement-breakpoint
CREATE TABLE `recurring_series` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`entity_id` text,
	`ownership` text,
	`vendor_id` text,
	`account_ref` text,
	`cadence` text NOT NULL,
	`start_month` text NOT NULL,
	`end_month` text,
	`match_rule` text,
	`warranty_subscription_id` text,
	`note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`warranty_subscription_id`) REFERENCES `warranty_subscriptions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recurring_series_cadence_check" CHECK("recurring_series"."cadence" IN ('monthly', 'bimonthly_odd', 'bimonthly_even', 'yearly')),
	CONSTRAINT "recurring_series_ownership_check" CHECK("recurring_series"."ownership" IS NULL OR "recurring_series"."ownership" IN ('per', 'corp', 'advance', 'custody', 'pending')),
	CONSTRAINT "recurring_series_month_check" CHECK("recurring_series"."start_month" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND ("recurring_series"."end_month" IS NULL OR "recurring_series"."end_month" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'))
);
--> statement-breakpoint
ALTER TABLE `document_files` ADD `storage` text DEFAULT 'r2' NOT NULL;--> statement-breakpoint
ALTER TABLE `document_files` ADD `local_path` text;--> statement-breakpoint
CREATE INDEX `document_files_local_path_idx` ON `document_files` (`local_path`);--> statement-breakpoint
ALTER TABLE `documents` ADD `filed_at` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `project_code` text;