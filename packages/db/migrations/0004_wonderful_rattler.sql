CREATE TABLE `asset_tags` (
	`asset_id` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`asset_id`, `tag`),
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `asset_tags_tag_idx` ON `asset_tags` (`tag`);--> statement-breakpoint
CREATE TABLE `document_case_links` (
	`case_id` text NOT NULL,
	`document_id` text NOT NULL,
	`role` text NOT NULL,
	`linked_by` text NOT NULL,
	`confidence_score` integer,
	`created_by_member_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`case_id`, `document_id`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_case_links_role_check" CHECK("document_case_links"."role" IN ('payment', 'reminder', 'penalty', 'enforcement', 'receipt', 'INV', 'WAR', 'RET', 'DEL', 'ORD', 'SUB', 'MAN')),
	CONSTRAINT "document_case_links_linked_by_check" CHECK("document_case_links"."linked_by" IN ('manual', 'auto')),
	CONSTRAINT "document_case_links_confidence_check" CHECK("document_case_links"."confidence_score" IS NULL OR ("document_case_links"."confidence_score" >= 0 AND "document_case_links"."confidence_score" <= 100))
);
--> statement-breakpoint
CREATE INDEX `document_case_links_document_idx` ON `document_case_links` (`document_id`);