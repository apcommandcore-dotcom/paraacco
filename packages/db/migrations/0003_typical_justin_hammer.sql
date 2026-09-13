CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`tax_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`budget_amount_cents` integer,
	`currency` text DEFAULT 'TWD',
	`start_date` text,
	`end_date` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "projects_status_check" CHECK("projects"."status" IN ('active', 'completed', 'cancelled')),
	CONSTRAINT "projects_budget_check" CHECK("projects"."budget_amount_cents" IS NULL OR "projects"."budget_amount_cents" >= 0)
);
--> statement-breakpoint
CREATE INDEX `projects_status_idx` ON `projects` (`status`);--> statement-breakpoint
CREATE TABLE `statement_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_id` text NOT NULL,
	`source_document_id` text NOT NULL,
	`date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`description` text NOT NULL,
	`reconciliation_status` text DEFAULT 'unmatched' NOT NULL,
	`matched_purchase_id` text,
	`match_confidence` real,
	`match_note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`matched_purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "statement_lines_status_check" CHECK("statement_lines"."reconciliation_status" IN ('matched', 'suggested', 'unmatched')),
	CONSTRAINT "statement_lines_match_confidence_check" CHECK("statement_lines"."match_confidence" IS NULL OR ("statement_lines"."match_confidence" >= 0 AND "statement_lines"."match_confidence" <= 100))
);
--> statement-breakpoint
CREATE INDEX `statement_lines_entity_idx` ON `statement_lines` (`entity_id`);--> statement-breakpoint
CREATE INDEX `statement_lines_source_doc_idx` ON `statement_lines` (`source_document_id`);--> statement-breakpoint
CREATE INDEX `statement_lines_status_idx` ON `statement_lines` (`reconciliation_status`);--> statement-breakpoint
CREATE INDEX `statement_lines_matched_purchase_idx` ON `statement_lines` (`matched_purchase_id`);--> statement-breakpoint
ALTER TABLE `documents` ADD `display_name` text;--> statement-breakpoint
ALTER TABLE `purchases` ADD `entity_id` text REFERENCES entities(id);--> statement-breakpoint
ALTER TABLE `purchases` ADD `project_id` text REFERENCES projects(id);--> statement-breakpoint
CREATE INDEX `purchases_entity_idx` ON `purchases` (`entity_id`);--> statement-breakpoint
CREATE INDEX `purchases_project_idx` ON `purchases` (`project_id`);