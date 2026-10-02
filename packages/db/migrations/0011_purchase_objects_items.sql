CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_by_member_id` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`updated_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `purchase_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_id` text NOT NULL,
	`purchase_item_id` text,
	`kind` text NOT NULL,
	`local_path` text NOT NULL,
	`original_file_name` text,
	`mime_type` text,
	`byte_size` integer,
	`sha256` text,
	`note` text,
	`created_by_member_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_item_id`) REFERENCES `purchase_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "purchase_attachments_kind_check" CHECK("purchase_attachments"."kind" IN ('video', 'photo', 'other'))
);
--> statement-breakpoint
CREATE INDEX `purchase_attachments_purchase_idx` ON `purchase_attachments` (`purchase_id`);--> statement-breakpoint
CREATE TABLE `purchase_items` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_id` text NOT NULL,
	`line_no` integer DEFAULT 0 NOT NULL,
	`name` text NOT NULL,
	`quantity` real DEFAULT 1 NOT NULL,
	`unit_price_cents` integer,
	`amount_cents` integer NOT NULL,
	`brand` text,
	`model` text,
	`serial_no` text,
	`ownership` text,
	`warranty_start_date` text,
	`warranty_end_date` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "purchase_items_ownership_check" CHECK("purchase_items"."ownership" IS NULL OR "purchase_items"."ownership" IN ('per', 'corp', 'advance', 'custody')),
	CONSTRAINT "purchase_items_source_check" CHECK("purchase_items"."source" IN ('invoice_line', 'manual', 'split')),
	CONSTRAINT "purchase_items_quantity_check" CHECK("purchase_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE INDEX `purchase_items_purchase_idx` ON `purchase_items` (`purchase_id`,`line_no`);--> statement-breakpoint
CREATE INDEX `purchase_items_warranty_idx` ON `purchase_items` (`warranty_end_date`);--> statement-breakpoint
ALTER TABLE `document_purchase_links` ADD `attachment_role` text;--> statement-breakpoint
ALTER TABLE `document_purchase_links` ADD `purchase_item_id` text;