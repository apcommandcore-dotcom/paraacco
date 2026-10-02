CREATE TABLE `advance_payees` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `item_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`code` text,
	`parent_id` text,
	`account_title` text,
	`default_ownership` text,
	`is_active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`color` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "item_categories_ownership_check" CHECK("item_categories"."default_ownership" IS NULL OR "item_categories"."default_ownership" IN ('per', 'corp', 'advance', 'custody'))
);
--> statement-breakpoint
CREATE TABLE `item_change_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_ids` text NOT NULL,
	`changes` text NOT NULL,
	`before` text NOT NULL,
	`undone_at` text,
	`actor_member_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`actor_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `item_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_tax_id` text NOT NULL,
	`name_keyword` text,
	`category_id` text,
	`ownership` text,
	`project_code` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_by_member_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `item_rules_vendor_idx` ON `item_rules` (`vendor_tax_id`);--> statement-breakpoint
ALTER TABLE `purchase_items` ADD `category_id` text;--> statement-breakpoint
ALTER TABLE `purchase_items` ADD `category_source` text;--> statement-breakpoint
ALTER TABLE `purchase_items` ADD `project_code` text;--> statement-breakpoint
ALTER TABLE `purchase_items` ADD `is_advance` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `purchase_items` ADD `advance_payee` text;--> statement-breakpoint
ALTER TABLE `purchase_items` ADD `advance_settled_at` text;--> statement-breakpoint
ALTER TABLE `purchase_items` ADD `exclude_from_report` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `purchase_items` ADD `exclude_reason` text;--> statement-breakpoint
ALTER TABLE `purchase_items` ADD `name_original` text;--> statement-breakpoint
-- 初始資料(CODE_TASK_purchase-object-merge-docs_20260929_V1.02.md 7.3;Theo 可在管理後台改)
INSERT INTO `item_categories` (`id`, `name`, `code`, `account_title`, `sort_order`) VALUES
  ('ICT-001', '餐費', 'MEAL', '伙食費', 10),
  ('ICT-002', '交通', 'TRAVEL', '旅費/交通費', 20),
  ('ICT-003', '辦公文具', 'OFFICE', '文具用品', 30),
  ('ICT-004', '設備器材', 'EQUIP', '什項購置/設備', 40),
  ('ICT-005', '工程材料', 'MATERIAL', '工程成本-材料', 50),
  ('ICT-006', '軟體/訂閱', 'SOFTWARE', '什項購置/雜項費用', 60),
  ('ICT-007', '郵電快遞', 'POST', '郵電費/運費', 70),
  ('ICT-008', '書報雜誌', 'BOOK', '書報雜誌', 80),
  ('ICT-009', '交際/禮品', 'GIFT', '交際費', 90),
  ('ICT-010', '修繕', 'REPAIR', '修繕費', 100),
  ('ICT-011', '醫療(家庭)', 'MEDICAL', '不列公司帳', 110),
  ('ICT-012', '其他', 'OTHER', '雜項費用', 120);
--> statement-breakpoint
INSERT INTO `advance_payees` (`id`, `name`, `sort_order`) VALUES ('owner', '業主', 10), ('company', '公司', 20), ('other', '其他', 30);
