CREATE TABLE `recurring_match_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`series_id` text,
	`period_key` text,
	`document_id` text,
	`statement_line_id` integer,
	`role` text,
	`reason` text NOT NULL,
	`note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by_member_id` text,
	`decided_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`series_id`) REFERENCES `recurring_series`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`statement_line_id`) REFERENCES `statement_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recurring_match_reviews_status_check" CHECK("recurring_match_reviews"."status" IN ('pending', 'accepted', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX `recurring_match_reviews_status_idx` ON `recurring_match_reviews` (`status`);--> statement-breakpoint
CREATE INDEX `recurring_match_reviews_doc_idx` ON `recurring_match_reviews` (`document_id`);--> statement-breakpoint
CREATE TABLE `recurring_periods` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`series_id` text NOT NULL,
	`period_key` text NOT NULL,
	`period_months` text NOT NULL,
	`due_date` text,
	`due_date_source` text DEFAULT 'estimated' NOT NULL,
	`amount_cents` integer,
	`bill_doc_id` text,
	`proof_doc_id` text,
	`statement_line_id` integer,
	`status` text DEFAULT 'expected' NOT NULL,
	`paid_at` text,
	`paid_source` text,
	`bill_missing_flag` integer DEFAULT false NOT NULL,
	`match_confidence` text,
	`match_note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`series_id`) REFERENCES `recurring_series`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bill_doc_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`proof_doc_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`statement_line_id`) REFERENCES `statement_lines`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recurring_periods_status_check" CHECK("recurring_periods"."status" IN ('expected', 'billed', 'debited', 'paid', 'waived', 'overdue')),
	CONSTRAINT "recurring_periods_paid_source_check" CHECK("recurring_periods"."paid_source" IS NULL OR "recurring_periods"."paid_source" IN ('statement', 'proof', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_periods_series_period_idx` ON `recurring_periods` (`series_id`,`period_key`);--> statement-breakpoint
CREATE INDEX `recurring_periods_bill_idx` ON `recurring_periods` (`bill_doc_id`);--> statement-breakpoint
CREATE INDEX `recurring_periods_proof_idx` ON `recurring_periods` (`proof_doc_id`);--> statement-breakpoint
ALTER TABLE `recurring_series` ADD `due_rule` text DEFAULT 'bill' NOT NULL;--> statement-breakpoint
ALTER TABLE `recurring_series` ADD `due_day` integer;--> statement-breakpoint
ALTER TABLE `recurring_series` ADD `amount_mode` text DEFAULT 'variable' NOT NULL;--> statement-breakpoint
ALTER TABLE `recurring_series` ADD `require_proof` integer DEFAULT false NOT NULL;