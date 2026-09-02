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
CREATE INDEX `activity_log_entity_idx` ON `activity_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `activity_log_created_idx` ON `activity_log` (`created_at`);--> statement-breakpoint
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
	`created_by_member_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "assets_ownership_check" CHECK("assets"."ownership" IN ('per', 'corp', 'advance', 'custody')),
	CONSTRAINT "assets_status_check" CHECK("assets"."status" IN ('active', 'scrap', 'moving', 'archived'))
);
--> statement-breakpoint
CREATE INDEX `assets_ownership_idx` ON `assets` (`ownership`);--> statement-breakpoint
CREATE INDEX `assets_status_idx` ON `assets` (`status`);--> statement-breakpoint
CREATE INDEX `assets_serial_idx` ON `assets` (`serial_no`);--> statement-breakpoint
CREATE INDEX `assets_purchase_idx` ON `assets` (`purchase_id`);--> statement-breakpoint
CREATE INDEX `assets_warranty_idx` ON `assets` (`warranty_end_date`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`ownership_scope` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "categories_scope_check" CHECK("categories"."ownership_scope" IN ('per', 'corp'))
);
--> statement-breakpoint
CREATE INDEX `categories_scope_idx` ON `categories` (`ownership_scope`,`parent_id`);--> statement-breakpoint
CREATE TABLE `document_asset_links` (
	`document_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`relation_kind` text DEFAULT 'supporting' NOT NULL,
	`linked_by` text NOT NULL,
	`confidence_score` integer,
	`created_by_member_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`document_id`, `asset_id`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_asset_links_relation_check" CHECK("document_asset_links"."relation_kind" IN ('primary', 'supporting', 'warranty', 'manual')),
	CONSTRAINT "document_asset_links_linked_by_check" CHECK("document_asset_links"."linked_by" IN ('manual', 'auto', 'import'))
);
--> statement-breakpoint
CREATE INDEX `document_asset_links_asset_idx` ON `document_asset_links` (`asset_id`);--> statement-breakpoint
CREATE TABLE `document_extracted_fields` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`field_key` text NOT NULL,
	`label` text NOT NULL,
	`value` text,
	`normalized_value` text,
	`confidence` real,
	`extraction_source` text NOT NULL,
	`source_note` text,
	`is_mono` integer DEFAULT false NOT NULL,
	`page_number` integer,
	`bbox_json` text,
	`is_user_confirmed` integer DEFAULT false NOT NULL,
	`confirmed_by_member_id` text,
	`confirmed_at` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`confirmed_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_extracted_fields_source_check" CHECK("document_extracted_fields"."extraction_source" IN ('ocr', 'qr', 'ai_inference', 'vendor_lookup', 'user_input')),
	CONSTRAINT "document_extracted_fields_confidence_check" CHECK("document_extracted_fields"."confidence" IS NULL OR ("document_extracted_fields"."confidence" >= 0 AND "document_extracted_fields"."confidence" <= 100))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_extracted_fields_doc_field_idx` ON `document_extracted_fields` (`document_id`,`field_key`);--> statement-breakpoint
CREATE TABLE `document_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`kind` text NOT NULL,
	`r2_key` text NOT NULL,
	`original_file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text,
	`page_number` integer,
	`is_current` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_files_kind_check" CHECK("document_files"."kind" IN ('original', 'normalized_pdf', 'page_image', 'thumbnail', 'ocr_json')),
	CONSTRAINT "document_files_byte_size_check" CHECK("document_files"."byte_size" >= 0)
);
--> statement-breakpoint
CREATE INDEX `document_files_document_idx` ON `document_files` (`document_id`);--> statement-breakpoint
CREATE INDEX `document_files_sha256_idx` ON `document_files` (`sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `document_files_r2_key_idx` ON `document_files` (`r2_key`);--> statement-breakpoint
CREATE TABLE `document_processing_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`stage_number` integer NOT NULL,
	`stage_key` text NOT NULL,
	`event_type` text NOT NULL,
	`detail_json` text,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `document_processing_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_processing_events_stage_check" CHECK("document_processing_events"."stage_number" BETWEEN 1 AND 8),
	CONSTRAINT "document_processing_events_event_type_check" CHECK("document_processing_events"."event_type" IN ('started', 'completed', 'skipped', 'retry_scheduled', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `document_processing_events_job_idx` ON `document_processing_events` (`job_id`);--> statement-breakpoint
CREATE TABLE `document_processing_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`workflow_instance_id` text,
	`queue_message_id` text,
	`current_stage` integer DEFAULT 1 NOT NULL,
	`stage_key` text DEFAULT 'queued' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error_code` text,
	`error_message` text,
	`locked_at` text,
	`started_at` text,
	`completed_at` text,
	`next_retry_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_processing_jobs_stage_check" CHECK("document_processing_jobs"."current_stage" BETWEEN 1 AND 8),
	CONSTRAINT "document_processing_jobs_status_check" CHECK("document_processing_jobs"."status" IN ('queued', 'running', 'waiting_review', 'completed', 'failed', 'retry'))
);
--> statement-breakpoint
CREATE INDEX `document_processing_jobs_document_idx` ON `document_processing_jobs` (`document_id`);--> statement-breakpoint
CREATE INDEX `document_processing_jobs_status_retry_idx` ON `document_processing_jobs` (`status`,`next_retry_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `document_purchase_links` (
	`document_id` text NOT NULL,
	`purchase_id` text NOT NULL,
	`relation_kind` text DEFAULT 'primary' NOT NULL,
	`linked_by` text NOT NULL,
	`confidence_score` integer,
	`created_by_member_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`document_id`, `purchase_id`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_purchase_links_relation_check" CHECK("document_purchase_links"."relation_kind" IN ('primary', 'supporting', 'duplicate_evidence')),
	CONSTRAINT "document_purchase_links_linked_by_check" CHECK("document_purchase_links"."linked_by" IN ('manual', 'auto', 'import'))
);
--> statement-breakpoint
CREATE INDEX `document_purchase_links_purchase_idx` ON `document_purchase_links` (`purchase_id`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`ownership` text NOT NULL,
	`vendor_id` text,
	`vendor_name_raw` text,
	`doc_type_code` text,
	`doc_date` text,
	`invoice_no` text,
	`order_no` text,
	`serial_no` text,
	`brand` text,
	`model` text,
	`amount_cents` integer,
	`currency` text DEFAULT 'TWD',
	`ocr_confidence` real,
	`source` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`duplicate_of_document_id` text,
	`created_by_member_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`archived_at` text,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "documents_ownership_check" CHECK("documents"."ownership" IN ('per', 'corp', 'advance', 'custody')),
	CONSTRAINT "documents_doc_type_check" CHECK("documents"."doc_type_code" IS NULL OR "documents"."doc_type_code" IN ('INV', 'WAR', 'RET', 'DEL', 'ORD', 'SUB', 'BIL', 'MAN')),
	CONSTRAINT "documents_source_check" CHECK("documents"."source" IN ('web_upload', 'mobile_scan', 'email_forward', 'api_import')),
	CONSTRAINT "documents_status_check" CHECK("documents"."status" IN ('queued', 'validating', 'ocr', 'extract', 'classifying', 'matching', 'vendor_check', 'review', 'archived', 'failed', 'retry', 'dup', 'ignored')),
	CONSTRAINT "documents_confidence_check" CHECK("documents"."ocr_confidence" IS NULL OR ("documents"."ocr_confidence" >= 0 AND "documents"."ocr_confidence" <= 100))
);
--> statement-breakpoint
CREATE INDEX `documents_ownership_idx` ON `documents` (`ownership`);--> statement-breakpoint
CREATE INDEX `documents_status_idx` ON `documents` (`status`);--> statement-breakpoint
CREATE INDEX `documents_vendor_idx` ON `documents` (`vendor_id`);--> statement-breakpoint
CREATE INDEX `documents_invoice_idx` ON `documents` (`invoice_no`);--> statement-breakpoint
CREATE INDEX `documents_order_idx` ON `documents` (`order_no`);--> statement-breakpoint
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
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "members_role_check" CHECK("members"."role" IN ('admin', 'accountant', 'principal')),
	CONSTRAINT "members_scope_check" CHECK("members"."scope" IN ('personal_corp', 'corp', 'corp_readonly')),
	CONSTRAINT "members_status_check" CHECK("members"."status" IN ('active', 'invited', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_email_idx` ON `members` (`email`);--> statement-breakpoint
CREATE TABLE `purchase_tags` (
	`purchase_id` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`purchase_id`, `tag`),
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `purchase_tags_tag_idx` ON `purchase_tags` (`tag`);--> statement-breakpoint
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
	`payer_kind` text DEFAULT 'company' NOT NULL,
	`payer` text,
	`reimbursement_status` text DEFAULT 'not_applicable' NOT NULL,
	`status` text DEFAULT 'archived' NOT NULL,
	`warranty_end_date` text,
	`order_no` text,
	`invoice_no` text,
	`created_by_member_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "purchases_ownership_check" CHECK("purchases"."ownership" IN ('per', 'corp', 'advance', 'custody')),
	CONSTRAINT "purchases_payer_kind_check" CHECK("purchases"."payer_kind" IN ('personal', 'company', 'external')),
	CONSTRAINT "purchases_reimbursement_check" CHECK("purchases"."reimbursement_status" IN ('not_applicable', 'pending', 'submitted', 'approved', 'reimbursed', 'rejected')),
	CONSTRAINT "purchases_status_check" CHECK("purchases"."status" IN ('draft', 'review', 'archived', 'failed', 'retry', 'dup')),
	CONSTRAINT "purchases_amount_check" CHECK("purchases"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE INDEX `purchases_ownership_idx` ON `purchases` (`ownership`);--> statement-breakpoint
CREATE INDEX `purchases_status_idx` ON `purchases` (`status`);--> statement-breakpoint
CREATE INDEX `purchases_vendor_idx` ON `purchases` (`vendor_id`);--> statement-breakpoint
CREATE INDEX `purchases_warranty_idx` ON `purchases` (`warranty_end_date`);--> statement-breakpoint
CREATE TABLE `relation_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`score` integer NOT NULL,
	`raw_score` integer NOT NULL,
	`reasons_json` text NOT NULL,
	`algorithm_version` text NOT NULL,
	`decision` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`decided_at` text,
	`decided_by_member_id` text,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "relation_candidates_target_type_check" CHECK("relation_candidates"."target_type" IN ('purchase', 'asset', 'document')),
	CONSTRAINT "relation_candidates_score_check" CHECK("relation_candidates"."score" BETWEEN 0 AND 100),
	CONSTRAINT "relation_candidates_decision_check" CHECK("relation_candidates"."decision" IN ('pending', 'accepted', 'rejected', 'superseded'))
);
--> statement-breakpoint
CREATE INDEX `relation_candidates_document_decision_idx` ON `relation_candidates` (`document_id`,`decision`,`score`);--> statement-breakpoint
CREATE TABLE `transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`from_ownership` text NOT NULL,
	`to_ownership` text NOT NULL,
	`reason` text NOT NULL,
	`impact_json` text,
	`requested_by_member_id` text NOT NULL,
	`approved_by_member_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decision_note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`requested_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transfers_target_type_check" CHECK("transfers"."target_type" IN ('purchase', 'asset')),
	CONSTRAINT "transfers_from_ownership_check" CHECK("transfers"."from_ownership" IN ('per', 'corp', 'advance', 'custody')),
	CONSTRAINT "transfers_to_ownership_check" CHECK("transfers"."to_ownership" IN ('per', 'corp', 'advance', 'custody')),
	CONSTRAINT "transfers_status_check" CHECK("transfers"."status" IN ('pending', 'approved', 'rejected', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `transfers_target_idx` ON `transfers` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `transfers_status_idx` ON `transfers` (`status`);--> statement-breakpoint
CREATE TABLE `vendor_aliases` (
	`vendor_id` text NOT NULL,
	`alias` text NOT NULL,
	PRIMARY KEY(`vendor_id`, `alias`),
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `vendor_aliases_alias_idx` ON `vendor_aliases` (`alias`);--> statement-breakpoint
CREATE TABLE `vendors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`tax_id` text,
	`default_ownership` text NOT NULL,
	`default_category_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "vendors_tax_id_check" CHECK("vendors"."tax_id" IS NULL OR length("vendors"."tax_id") = 8),
	CONSTRAINT "vendors_ownership_check" CHECK("vendors"."default_ownership" IN ('per', 'corp'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendors_tax_id_idx` ON `vendors` (`tax_id`);--> statement-breakpoint
CREATE INDEX `vendors_name_idx` ON `vendors` (`name`);