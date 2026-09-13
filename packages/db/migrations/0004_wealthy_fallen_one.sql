PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_documents` (
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
	`display_name` text,
	`source` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`duplicate_of_document_id` text,
	`created_by_member_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`archived_at` text,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "documents_ownership_check" CHECK("__new_documents"."ownership" IN ('per', 'corp', 'advance', 'custody')),
	CONSTRAINT "documents_doc_type_check" CHECK("__new_documents"."doc_type_code" IS NULL OR "__new_documents"."doc_type_code" IN ('INV', 'WAR', 'RET', 'DEL', 'ORD', 'SUB', 'BIL', 'MAN')),
	CONSTRAINT "documents_source_check" CHECK("__new_documents"."source" IN ('web_upload', 'mobile_scan', 'email_forward', 'api_import', 'local-scanner-batch')),
	CONSTRAINT "documents_status_check" CHECK("__new_documents"."status" IN ('queued', 'validating', 'ocr', 'extract', 'classifying', 'matching', 'vendor_check', 'review', 'archived', 'failed', 'retry', 'dup', 'ignored')),
	CONSTRAINT "documents_confidence_check" CHECK("__new_documents"."ocr_confidence" IS NULL OR ("__new_documents"."ocr_confidence" >= 0 AND "__new_documents"."ocr_confidence" <= 100))
);
--> statement-breakpoint
INSERT INTO `__new_documents`("id", "ownership", "vendor_id", "vendor_name_raw", "doc_type_code", "doc_date", "invoice_no", "order_no", "serial_no", "brand", "model", "amount_cents", "currency", "ocr_confidence", "display_name", "source", "status", "duplicate_of_document_id", "created_by_member_id", "created_at", "updated_at", "archived_at") SELECT "id", "ownership", "vendor_id", "vendor_name_raw", "doc_type_code", "doc_date", "invoice_no", "order_no", "serial_no", "brand", "model", "amount_cents", "currency", "ocr_confidence", "display_name", "source", "status", "duplicate_of_document_id", "created_by_member_id", "created_at", "updated_at", "archived_at" FROM `documents`;--> statement-breakpoint
DROP TABLE `documents`;--> statement-breakpoint
ALTER TABLE `__new_documents` RENAME TO `documents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `documents_ownership_idx` ON `documents` (`ownership`);--> statement-breakpoint
CREATE INDEX `documents_status_idx` ON `documents` (`status`);--> statement-breakpoint
CREATE INDEX `documents_vendor_idx` ON `documents` (`vendor_id`);--> statement-breakpoint
CREATE INDEX `documents_invoice_idx` ON `documents` (`invoice_no`);--> statement-breakpoint
CREATE INDEX `documents_order_idx` ON `documents` (`order_no`);