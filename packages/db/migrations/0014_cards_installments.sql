CREATE TABLE `card_statement_months` (
	`series_id` text NOT NULL,
	`month` text NOT NULL,
	`amount_cents` integer,
	`due_date` text,
	`paid_at` text,
	`note` text,
	`updated_by_member_id` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`series_id`, `month`),
	FOREIGN KEY (`series_id`) REFERENCES `recurring_series`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `installment_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`series_id` text NOT NULL,
	`merchant` text NOT NULL,
	`total_cents` integer NOT NULL,
	`period_count` integer NOT NULL,
	`per_period_cents` integer NOT NULL,
	`first_month` text NOT NULL,
	`ownership` text,
	`document_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`note` text,
	`created_by_member_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`series_id`) REFERENCES `recurring_series`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "installment_plans_status_check" CHECK("installment_plans"."status" IN ('active', 'cancelled')),
	CONSTRAINT "installment_plans_count_check" CHECK("installment_plans"."period_count" >= 1 AND "installment_plans"."period_count" <= 120),
	CONSTRAINT "installment_plans_month_check" CHECK("installment_plans"."first_month" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]')
);
--> statement-breakpoint
CREATE INDEX `installment_plans_series_idx` ON `installment_plans` (`series_id`);--> statement-breakpoint
CREATE INDEX `installment_plans_doc_idx` ON `installment_plans` (`document_id`);--> statement-breakpoint
ALTER TABLE `recurring_series` ADD `card_kind` text;--> statement-breakpoint
ALTER TABLE `recurring_series` ADD `statement_day` integer;--> statement-breakpoint
ALTER TABLE `recurring_series` ADD `debit_account` text;