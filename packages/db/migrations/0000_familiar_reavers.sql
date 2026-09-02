CREATE TABLE `activity_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`actor_member_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`actor_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`ownership` text NOT NULL,
	`name` text NOT NULL,
	`category_id` text,
	`brand` text,
	`model` text,
	`serial_no` text,
	`acquired_date` text,
	`holder_entity` text,
	`keeper` text,
	`location` text,
	`warranty_end_date` text,
	`status` text DEFAULT 'active' NOT NULL,
	`purchase_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`ownership_scope` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `document_fields` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`field_key` text NOT NULL,
	`label` text NOT NULL,
	`value` text,
	`confidence` integer,
	`is_mono` integer DEFAULT false NOT NULL,
	`source_note` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`ownership` text NOT NULL,
	`vendor_id` text,
	`vendor_name_raw` text,
	`file_name` text NOT NULL,
	`doc_type_code` text,
	`doc_date` text,
	`amount_cents` integer,
	`currency` text DEFAULT 'TWD',
	`ocr_confidence` integer,
	`source` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`pipeline_step` integer DEFAULT 1 NOT NULL,
	`sha256` text,
	`r2_key` text,
	`purchase_id` text,
	`asset_id` text,
	`duplicate_of_document_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `id_sequences` (
	`entity` text NOT NULL,
	`year` integer NOT NULL,
	`last_seq` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`entity`, `year`)
);
--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`scope` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `processing_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`stage` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `purchase_tags` (
	`purchase_id` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`purchase_id`, `tag`),
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`ownership` text NOT NULL,
	`purchase_date` text NOT NULL,
	`vendor_id` text,
	`vendor_name_raw` text NOT NULL,
	`summary` text NOT NULL,
	`sub_note` text,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'TWD' NOT NULL,
	`category_id` text,
	`account_type` text,
	`payer` text,
	`reimbursement_status` text DEFAULT 'not_applicable' NOT NULL,
	`status` text DEFAULT 'archived' NOT NULL,
	`warranty_end_date` text,
	`order_no` text,
	`invoice_no` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`from_ownership` text NOT NULL,
	`to_ownership` text NOT NULL,
	`reason` text NOT NULL,
	`requested_by` text NOT NULL,
	`approved_by` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`requested_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `vendor_aliases` (
	`vendor_id` text NOT NULL,
	`alias` text NOT NULL,
	PRIMARY KEY(`vendor_id`, `alias`),
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `vendors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`tax_id` text,
	`default_ownership` text NOT NULL,
	`default_category_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_log_entity_idx` ON `activity_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `activity_log_created_idx` ON `activity_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `assets_ownership_idx` ON `assets` (`ownership`);--> statement-breakpoint
CREATE INDEX `assets_status_idx` ON `assets` (`status`);--> statement-breakpoint
CREATE INDEX `assets_serial_idx` ON `assets` (`serial_no`);--> statement-breakpoint
CREATE INDEX `assets_purchase_idx` ON `assets` (`purchase_id`);--> statement-breakpoint
CREATE INDEX `assets_warranty_idx` ON `assets` (`warranty_end_date`);--> statement-breakpoint
CREATE INDEX `categories_scope_idx` ON `categories` (`ownership_scope`,`parent_id`);--> statement-breakpoint
CREATE INDEX `document_fields_document_idx` ON `document_fields` (`document_id`);--> statement-breakpoint
CREATE INDEX `documents_ownership_idx` ON `documents` (`ownership`);--> statement-breakpoint
CREATE INDEX `documents_status_idx` ON `documents` (`status`);--> statement-breakpoint
CREATE INDEX `documents_purchase_idx` ON `documents` (`purchase_id`);--> statement-breakpoint
CREATE INDEX `documents_asset_idx` ON `documents` (`asset_id`);--> statement-breakpoint
CREATE INDEX `documents_sha256_idx` ON `documents` (`sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `members_email_idx` ON `members` (`email`);--> statement-breakpoint
CREATE INDEX `processing_history_document_idx` ON `processing_history` (`document_id`);--> statement-breakpoint
CREATE INDEX `purchase_tags_tag_idx` ON `purchase_tags` (`tag`);--> statement-breakpoint
CREATE INDEX `purchases_ownership_idx` ON `purchases` (`ownership`);--> statement-breakpoint
CREATE INDEX `purchases_status_idx` ON `purchases` (`status`);--> statement-breakpoint
CREATE INDEX `purchases_vendor_idx` ON `purchases` (`vendor_id`);--> statement-breakpoint
CREATE INDEX `purchases_warranty_idx` ON `purchases` (`warranty_end_date`);--> statement-breakpoint
CREATE INDEX `transfers_target_idx` ON `transfers` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `transfers_status_idx` ON `transfers` (`status`);--> statement-breakpoint
CREATE INDEX `vendor_aliases_alias_idx` ON `vendor_aliases` (`alias`);--> statement-breakpoint
CREATE UNIQUE INDEX `vendors_tax_id_idx` ON `vendors` (`tax_id`);--> statement-breakpoint
CREATE INDEX `vendors_name_idx` ON `vendors` (`name`);