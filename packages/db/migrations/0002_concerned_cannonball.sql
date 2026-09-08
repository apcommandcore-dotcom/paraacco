PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_assets` (
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
	`vendor_name` text,
	`amount_cents` integer,
	`currency` text DEFAULT 'TWD',
	`note` text,
	`created_by_member_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "assets_ownership_check" CHECK("__new_assets"."ownership" IN ('per', 'corp', 'advance', 'custody')),
	CONSTRAINT "assets_status_check" CHECK("__new_assets"."status" IN ('active', 'scrap', 'moving', 'archived')),
	CONSTRAINT "assets_amount_check" CHECK("__new_assets"."amount_cents" IS NULL OR "__new_assets"."amount_cents" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_assets`("id", "ownership", "name", "category_id", "brand", "model", "serial_no", "acquired_date", "holder_entity", "keeper", "location", "warranty_end_date", "status", "purchase_id", "vendor_name", "amount_cents", "currency", "note", "created_by_member_id", "created_at", "updated_at") SELECT "id", "ownership", "name", "category_id", "brand", "model", "serial_no", "acquired_date", "holder_entity", "keeper", "location", "warranty_end_date", "status", "purchase_id", "vendor_name", "amount_cents", "currency", "note", "created_by_member_id", "created_at", "updated_at" FROM `assets`;--> statement-breakpoint
DROP TABLE `assets`;--> statement-breakpoint
ALTER TABLE `__new_assets` RENAME TO `assets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `assets_ownership_idx` ON `assets` (`ownership`);--> statement-breakpoint
CREATE INDEX `assets_status_idx` ON `assets` (`status`);--> statement-breakpoint
CREATE INDEX `assets_serial_idx` ON `assets` (`serial_no`);--> statement-breakpoint
CREATE INDEX `assets_purchase_idx` ON `assets` (`purchase_id`);--> statement-breakpoint
CREATE INDEX `assets_warranty_idx` ON `assets` (`warranty_end_date`);