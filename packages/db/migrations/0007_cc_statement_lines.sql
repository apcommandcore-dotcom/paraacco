-- 2026-09-21 手動修正:drizzle-kit 0.31.10 產生的 INSERT...SELECT 從舊表選取了尚不存在的新欄位
-- (post_date/bank/currency/raw_line/ownership)。SQLite 會把不存在的雙引號識別字當字串常數,
-- 導致既有資料被寫入 'ownership' 等字面值並觸發 CHECK 失敗。改為只複製原有 12 欄,新欄位走預設值。
-- drizzle 原始產出保留於同目錄快照。snapshot.json 未改動,schema 同步狀態不受影響。
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_statement_lines` (
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
	`post_date` text,
	`bank` text,
	`currency` text DEFAULT 'TWD',
	`raw_line` text,
	`ownership` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`matched_purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "statement_lines_ownership_check" CHECK("__new_statement_lines"."ownership" IN ('pending', 'per', 'corp', 'advance', 'custody')),
	CONSTRAINT "statement_lines_status_check" CHECK("__new_statement_lines"."reconciliation_status" IN ('matched', 'suggested', 'unmatched')),
	CONSTRAINT "statement_lines_match_confidence_check" CHECK("__new_statement_lines"."match_confidence" IS NULL OR ("__new_statement_lines"."match_confidence" >= 0 AND "__new_statement_lines"."match_confidence" <= 100))
);
--> statement-breakpoint
INSERT INTO `__new_statement_lines`("id", "entity_id", "source_document_id", "date", "amount_cents", "description", "reconciliation_status", "matched_purchase_id", "match_confidence", "match_note", "created_at", "updated_at") SELECT "id", "entity_id", "source_document_id", "date", "amount_cents", "description", "reconciliation_status", "matched_purchase_id", "match_confidence", "match_note", "created_at", "updated_at" FROM `statement_lines`;--> statement-breakpoint
DROP TABLE `statement_lines`;--> statement-breakpoint
ALTER TABLE `__new_statement_lines` RENAME TO `statement_lines`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `statement_lines_entity_idx` ON `statement_lines` (`entity_id`);--> statement-breakpoint
CREATE INDEX `statement_lines_bank_idx` ON `statement_lines` (`bank`);--> statement-breakpoint
CREATE INDEX `statement_lines_ownership_idx` ON `statement_lines` (`ownership`);--> statement-breakpoint
CREATE INDEX `statement_lines_source_doc_idx` ON `statement_lines` (`source_document_id`);--> statement-breakpoint
CREATE INDEX `statement_lines_status_idx` ON `statement_lines` (`reconciliation_status`);--> statement-breakpoint
CREATE INDEX `statement_lines_matched_purchase_idx` ON `statement_lines` (`matched_purchase_id`);